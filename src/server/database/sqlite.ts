import { drizzle } from 'drizzle-orm/libsql';
import { migrate as drizzleMigrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { createDebug } from 'obug';
import { eq } from 'drizzle-orm';

import { GeneralService } from '#db/repositories/general/service';
import { UserService } from '#db/repositories/user/service';
import { UserConfigService } from '#db/repositories/userConfig/service';
import { InterfaceService } from '#db/repositories/interface/service';
import { HooksService } from '#db/repositories/hooks/service';
import { OneTimeLinkService } from '#db/repositories/oneTimeLink/service';
import { ClientService } from '#db/repositories/client/service';
import * as schema from '#db/schema';
import { WG_ENV, WG_INITIAL_ENV } from '#server/utils/config';

const DB_DEBUG = createDebug('Database');

const client = createClient({ url: 'file:/etc/wireguard/wg-easy.db' });
const db = drizzle({ client, schema });

export async function connect() {
  await migrate();
  await normalizeDeviceName(db);
  await normalizeInterfaceName(db);
  const dbService = new DBService(db);

  if (WG_INITIAL_ENV.ENABLED) {
    await initialSetup(dbService);
  }

  if (WG_ENV.DISABLE_IPV6) {
    DB_DEBUG('Warning: Disabling IPv6...');
    await disableIpv6(db);
  }

  return dbService;
}

class DBService {
  clients: ClientService;
  general: GeneralService;
  users: UserService;
  userConfigs: UserConfigService;
  interfaces: InterfaceService;
  hooks: HooksService;
  oneTimeLinks: OneTimeLinkService;

  constructor(db: DBType) {
    this.clients = new ClientService(db);
    this.general = new GeneralService(db);
    this.users = new UserService(db);
    this.userConfigs = new UserConfigService(db);
    this.interfaces = new InterfaceService(db);
    this.hooks = new HooksService(db);
    this.oneTimeLinks = new OneTimeLinkService(db);
  }
}

export type DBType = typeof db;
export type DBServiceType = DBService;

async function migrate() {
  try {
    DB_DEBUG('Migrating database...');
    await drizzleMigrate(db, {
      migrationsFolder: './server/database/migrations',
    });
    DB_DEBUG('Migration complete');
  } catch (e) {
    if (e instanceof Error) {
      DB_DEBUG('Failed to migrate database:', e.message);
    }
    throw e;
  }
}

async function initialSetup(db: DBServiceType) {
  const setup = await db.general.getSetupStep();

  if (setup.done) {
    DB_DEBUG('Setup already done. Skiping initial setup.');
    return;
  }

  if (WG_INITIAL_ENV.IPV4_CIDR && WG_INITIAL_ENV.IPV6_CIDR) {
    DB_DEBUG('Setting initial CIDR...');
    await db.interfaces.updateCidr({
      ipv4Cidr: WG_INITIAL_ENV.IPV4_CIDR,
      ipv6Cidr: WG_INITIAL_ENV.IPV6_CIDR,
    });
  }

  if (WG_INITIAL_ENV.DNS) {
    DB_DEBUG('Setting initial DNS...');
    await db.userConfigs.update({
      defaultDns: WG_INITIAL_ENV.DNS,
    });
  }

  if (WG_INITIAL_ENV.ALLOWED_IPS) {
    DB_DEBUG('Setting initial Allowed IPs...');
    await db.userConfigs.update({
      defaultAllowedIps: WG_INITIAL_ENV.ALLOWED_IPS,
    });
  }

  if (
    WG_INITIAL_ENV.USERNAME &&
    WG_INITIAL_ENV.PASSWORD &&
    WG_INITIAL_ENV.HOST &&
    WG_INITIAL_ENV.PORT
  ) {
    DB_DEBUG('Creating initial user...');
    await db.users.create(WG_INITIAL_ENV.USERNAME, WG_INITIAL_ENV.PASSWORD);

    DB_DEBUG('Setting initial host and port...');
    await db.userConfigs.updateHostPort(
      WG_INITIAL_ENV.HOST,
      WG_INITIAL_ENV.PORT
    );

    await db.general.setSetupStep(0);
  }
}

/**
 * Updates the wgInterface.device column from 'eth0' to WG_DEVICE env var.
 * The device value is used as {{device}} in PostUp/PostDown hook templates —
 * it is NOT stored literally in the hook text, so we update the column directly.
 * Runs after migration. Idempotent when WG_DEVICE=eth0.
 */
async function normalizeDeviceName(db: DBType) {
  const device = WG_ENV.WG_DEVICE;
  if (device === 'eth0') return;

  DB_DEBUG(
    `Normalizing device name 'eth0' -> '${device}' in interface table...`
  );

  const iface = await db.query.wgInterface.findFirst({
    where: eq(schema.wgInterface.name, 'wg0'),
    columns: { device: true },
  });

  if (!iface) return;

  if (iface.device === 'eth0') {
    await db
      .update(schema.wgInterface)
      .set({ device })
      .where(eq(schema.wgInterface.name, 'wg0'))
      .execute();
    DB_DEBUG(`Device normalized to '${device}' in interface table.`);
  }
}

/**
 * Replaces hardcoded 'wg0' in the stored iptables hook commands with the
 * actual WG_INTERFACE name. Runs after migration so fresh installs that use a
 * non-default interface (e.g. wg1) get the correct interface name in their
 * PostUp/PostDown rules. Idempotent when WG_INTERFACE=wg0.
 */
async function normalizeInterfaceName(db: DBType) {
  const iface = WG_ENV.WG_INTERFACE;
  if (iface === 'wg0') return;

  DB_DEBUG(`Normalizing interface name 'wg0' -> '${iface}' in hooks...`);

  await db.transaction(async (tx) => {
    const hooks = await tx.query.hooks.findFirst({
      where: eq(schema.hooks.id, 'wg0'),
    });

    if (!hooks) return;

    const needsUpdate =
      hooks.postUp.includes('wg0') || hooks.postDown.includes('wg0');

    if (needsUpdate) {
      await tx
        .update(schema.hooks)
        .set({
          postUp: hooks.postUp.replaceAll('wg0', iface),
          postDown: hooks.postDown.replaceAll('wg0', iface),
        })
        .where(eq(schema.hooks.id, 'wg0'))
        .execute();
      DB_DEBUG(`Interface name normalized to '${iface}' in hooks.`);
    }
  });
}

async function disableIpv6(db: DBType) {
  const iface = WG_ENV.WG_INTERFACE;
  // This should match the initial value migration (after normalizeInterfaceName runs)
  const postUpMatch = ` ip6tables -t nat -A POSTROUTING -s {{ipv6Cidr}} -o {{device}} -j MASQUERADE; ip6tables -A INPUT -p udp -m udp --dport {{port}} -j ACCEPT; ip6tables -A FORWARD -i ${iface} -j ACCEPT; ip6tables -A FORWARD -o ${iface} -j ACCEPT;`;
  const postDownMatch = ` ip6tables -t nat -D POSTROUTING -s {{ipv6Cidr}} -o {{device}} -j MASQUERADE; ip6tables -D INPUT -p udp -m udp --dport {{port}} -j ACCEPT; ip6tables -D FORWARD -i ${iface} -j ACCEPT; ip6tables -D FORWARD -o ${iface} -j ACCEPT;`;

  await db.transaction(async (tx) => {
    const hooks = await tx.query.hooks.findFirst({
      where: eq(schema.hooks.id, 'wg0'),
    });

    if (!hooks) {
      throw new Error('Hooks not found');
    }

    if (hooks.postUp.includes(postUpMatch)) {
      DB_DEBUG('Disabling IPv6 in Post Up hooks...');
      await tx
        .update(schema.hooks)
        .set({
          postUp: hooks.postUp.replace(postUpMatch, ''),
          postDown: hooks.postDown.replace(postDownMatch, ''),
        })
        .where(eq(schema.hooks.id, 'wg0'))
        .execute();
    } else {
      DB_DEBUG('IPv6 Post Up hooks already disabled, skipping...');
    }
    if (hooks.postDown.includes(postDownMatch)) {
      DB_DEBUG('Disabling IPv6 in Post Down hooks...');
      await tx
        .update(schema.hooks)
        .set({
          postUp: hooks.postUp.replace(postUpMatch, ''),
          postDown: hooks.postDown.replace(postDownMatch, ''),
        })
        .where(eq(schema.hooks.id, 'wg0'))
        .execute();
    } else {
      DB_DEBUG('IPv6 Post Down hooks already disabled, skipping...');
    }
  });
}

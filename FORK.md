# Cellint fork of wg-easy

This is a downstream fork of [`wg-easy/wg-easy`](https://github.com/wg-easy/wg-easy).
We do **not** contribute changes back upstream. This document is the single source
of truth for **everything we changed on top of upstream** and **how to pull a new
upstream release without losing it**.

Read this before every upstream sync.

---

## Branch & sync model

- **`master` is our single long-lived integration branch** — it carries
  `upstream + our delta`, is the repo default, and is the branch we deploy from. We do
  **not** keep a pristine upstream mirror branch, and there is no separate feature
  branch for our customizations; they live on `master`.
- **Sync by merging, never rebasing.** Rebasing a shared long-lived branch rewrites
  history and forces you to re-resolve the same conflicts every time. `git merge`
  resolves each conflict once.
- `upstream` remote = `git@github.com:wg-easy/wg-easy.git`.
  `origin` = `git@github.com:CellintBio/wg-easy.git`.
- Enable conflict-resolution memory once per clone so future merges auto-apply the
  same resolutions:

  ```bash
  git config rerere.enabled true
  ```

- Deploy from a **tag**, not a branch tip, so a build is reproducible.

---

## Our delta vs upstream (the complete list)

Everything we add lives in these files. `git diff upstream/master HEAD` should only
ever touch this set (plus lockfiles). If a sync makes it touch anything else,
investigate.

### A. Feature: configurable WireGuard interface & outgoing device

Upstream hardcodes the interface name (`wg0`, from the DB `interfaces_table`) and the
NAT device (`eth0`). We make both overridable by env var so we can run multiple
instances and work on EKS where the NIC is `ens5`.

| File | What we changed | Why |
| --- | --- | --- |
| `src/server/utils/config.ts` | Add `WG_INTERFACE` (default `wg0`) and `WG_DEVICE` (default `eth0`) to the `WG_ENV` object. | Single source of truth for the two overrides. |
| `src/server/utils/WireGuard.ts` | Replace every `wgInterface.name` used as the live interface name (`wg.dump/sync/up/down/restart`, the `.conf` path, debug strings) with `WG_ENV.WG_INTERFACE`. | Use the env-var name instead of the DB value. |
| `src/server/database/sqlite.ts` | Add `normalizeDeviceName()` and `normalizeInterfaceName()`, called from `connect()` after `migrate()`. Also parameterize the `disableIpv6()` hook-match strings with the interface name. | The DB seeds `device='eth0'` and hook commands with literal `wg0`; these rewrite them to the configured values on boot (idempotent when defaults are used). |
| `src/server/utils/ip.ts` | In `getPrivateInformation()`, skip the interface using `process.env.WG_INTERFACE ?? 'wg0'` instead of the literal `'wg0'`. | Reads `process.env` **directly** (not `WG_ENV`) on purpose — see note below. |
| `Dockerfile` | Add `ENV WG_INTERFACE=wg0` and `ENV WG_DEVICE=eth0`. | Document/default the vars in the image. |
| `docs/content/advanced/config/optional-config.md` | Add `WG_INTERFACE` / `WG_DEVICE` rows to the env-var table. | Docs. |

### B. CI/CD: manual build & push to our AWS ECR

| File | What it is |
| --- | --- |
| `.github/workflows/ecr-deploy.yml` | Manual (`workflow_dispatch`) build & push of the image to `cellint/wg-easy` ECR. Tag chosen at dispatch (SemVer, `v`-prefixed). amd64 only. OIDC auth via repo var `ECR_PUSH_ROLE_ARN`. Mirrors the cellint monorepo pattern. |
| `.github/actions/teams-notify/action.yml` | Vendored copy of the monorepo's Teams-notify composite action (composite actions can't be referenced across repos). |

These two files are **purely additive** — upstream has nothing at these paths, so they
never conflict. Upstream's own deploy workflows (`deploy.yml`, etc.) are all gated on
`github.repository_owner == 'wg-easy'`, so they stay inert in our fork and do not need
touching.

---

## Assumptions our feature makes about upstream internals

If a future upstream release changes any of these, our patch needs rework (not just a
mechanical merge). Check them when the merge touches `src/server/database/**`:

1. **DB schema shape.** `normalize*` in `sqlite.ts` assumes:
   - an `interfaces_table` (Drizzle `schema.wgInterface`) with a `name` PK and a
     `device` column, seeded with `wg0` / `eth0`;
   - a `hooks` table (`schema.hooks`) keyed by interface id with `postUp` / `postDown`
     command strings that contain the literal interface name and a `{{device}}`
     template placeholder.
2. **Auto-imports are OFF.** Upstream disabled Nuxt auto-imports in #2672. That is why
   `ip.ts` reads `process.env.WG_INTERFACE` **directly** instead of importing `WG_ENV`
   from `config.ts`: importing `config.ts` there pulls its import-time side effects
   (`assertEnv('PORT')` + `detectAwg()` subprocess) into the isolated `ip.spec.ts`
   unit test and breaks it. Keep the direct `process.env` read in `ip.ts`.
3. **`mergeClientStatuses`.** Upstream's client-status merge helper is what
   `WireGuard.ts` calls after `wg.dump(...)`. Keep upstream's call; only the interface
   argument is ours.

---

## Recurring conflict hotspots & how to resolve them

When you merge upstream, expect conflicts in the files below. The resolution is always
"**keep upstream's structure, re-apply our override**":

- **`src/server/utils/config.ts`** — conflicts whenever upstream adds env vars near
  ours in the `WG_ENV` object. → Keep both: our `WG_INTERFACE`/`WG_DEVICE` lines plus
  whatever upstream added.
- **`src/server/utils/WireGuard.ts`** — conflicts whenever upstream refactors the
  dump/interface code. → Take upstream's new code, then substitute
  `WG_ENV.WG_INTERFACE` wherever it uses the live interface name. Do **not** reintroduce
  unused `const wgInterface = await Database.interfaces.get()` locals — if a function
  only needed the interface for its name, drop the local (lint fails otherwise).
- **`Dockerfile`** — conflicts around the ENV block or the libsql install. → Keep our
  two `ENV` lines; take upstream's libsql approach (currently a `build-libsql` stage).
- **`src/server/database/sqlite.ts`** — usually auto-merges; verify against assumption
  #1 above.
- **`docs/.../optional-config.md`** — merge the table rows.

---

## Upstream sync playbook

```bash
# 0. one-time per clone
git config rerere.enabled true

# 1. fetch
git remote get-url upstream            # expect wg-easy/wg-easy
git fetch upstream --tags

# 2. merge on a throwaway branch first (never straight onto master)
git checkout master
git pull
git checkout -b merge/upstream-<version>
git merge upstream/master              # resolve conflicts per the section above

# 3. validate (deps live under src/)
cd src
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check                      # run `pnpm format` if it complains
pnpm test:unit
cd ..
docker build -t wg-easy:localtest .    # proves the image still builds

# 4. sanity-check the delta is still only our files
git diff --stat upstream/master HEAD   # should match "Our delta vs upstream" above

# 5. open a PR into master, review, merge
```

### After merging & deploying

1. Bump `src/package.json` `version` (SemVer) if you want the app to report the new
   version — the canonical version lives there (root `package.json` is a stale
   placeholder).
2. Run the **"wg-easy — build & push to ECR"** workflow with the new tag (e.g.
   `v15.4.0`).
3. Bump the image `tag:` in the consuming Helm values in `cellint-iac`
   (`k8s/infra/wg-admin/values.prod.yaml` and `k8s/infra/wg-devices/values.prod.yaml`).

---

## One-time infra prerequisites for the ECR workflow

Required before the ECR workflow can run (see the cellint-iac `github-actions.tf`):

- The shared `github-ecr-push` OIDC role must **trust** `CellintBio/wg-easy` (add the
  fork's `sub`, both name form `repo:CellintBio/wg-easy:*` and immutable form
  `repo:CellintBio@212727044/wg-easy@1212426989:*`) **and** list
  `module.ecr_wg_easy.repository_arn` in its push policy.
- In the `CellintBio/wg-easy` repo settings: variable `ECR_PUSH_ROLE_ARN` (required),
  variable `AWS_REGION` (optional, defaults `us-east-1`), secret `TEAMS_WEBHOOK_URL`
  (optional).

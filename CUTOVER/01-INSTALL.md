# 01 · Install

**Status: ACTIVE** · Managed path (Supabase-hosted) is real and verified against this repo. Self-hosted path is a stub — see bottom.

Owner of the facts below (do not restate elsewhere — link here): environment variables → `web/.env.example`; migrations → `web/supabase/migrations/`; seed chain → `web/package.json` `seed:all` script.

---

## Managed path (Supabase-hosted Postgres, Vercel-deployed app)

### 0. Prerequisites
- Node 20+ (CI's `verify` job pins Node 20; the weekly `e2e-smoke.yml` job pins Node 22 — Node 22+ is required if you'll run `auth-smoke.mjs` locally, since `@supabase/supabase-js` realtime needs native `WebSocket`).
- npm (ships with Node).
- git.
- A Supabase account — free tier is sufficient to bring the app up (see `docs/adr/0001-stack-host-scope.md` for why Supabase was chosen).
- A Vercel account, if you intend to deploy — see [02-DEPLOY.md](02-DEPLOY.md).

### 1. Clone
```bash
git clone <your-fork-or-clone-url> NoPM
cd NoPM
```

### 2. Install dependencies
```bash
cd web
npm install
```
`npm install` also runs the repo's `prepare` script (`web/scripts/prepare.mjs`), which installs the git hooks (`.githooks/pre-commit` leak gate, `pre-push` full verify) when run inside a full clone. It intentionally no-ops when there is no repo root to hook into (e.g. a Vercel build with `web/` as the project root) — see `web/scripts/prepare.mjs`.

### 3. Environment — `.env.local` from `.env.example`
```bash
cp .env.example .env.local
```
Then fill in every value in `web/.env.local` (gitignored — never commit it). Each variable's purpose, verified against `web/.env.example`:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL (Project Settings → API). Public — shipped to the browser. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key. Public — RLS is the actual boundary. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only. Bypasses RLS — used by ops scripts (seed, bootstrap, migrate helpers) and the admin client for token-authenticated API calls. Never expose to the client, never log it. |
| `SUPABASE_DB_PASSWORD` | The database password you set when creating the Supabase project. Used to derive `DB_URL`. |
| `DB_URL` | Direct Postgres connection string for `scripts/apply-migrations.mjs` / `scripts/migrate.mjs`. `scripts/migrate.mjs` derives this from `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_DB_PASSWORD` if you don't set it explicitly. |
| `NEXT_PUBLIC_APP_URL` | The app's own base URL (`http://localhost:3000` locally). |
| `NOPM_TOKEN_PREFIX` | Prefix for scoped Bearer PATs (`npm_`). Leave as shipped unless you have a reason to change it. |
| `NOPM_ENCRYPTION_KEY` | Server-only. AES-256-GCM key for BYOK assistant credentials at rest — generate with `openssl rand -base64 32`. Losing/rotating this orphans any stored BYOK provider keys. |
| `DEMO_EMAIL` / `DEMO_PASSWORD` | Server-only. Backs `POST /api/auth/demo-login` (the public "Try the live demo" button, R-53). Optional if you don't want a public demo entry. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Used by ops scripts only (`scripts/bootstrap.mjs` mints the first admin login; `scripts/auth-smoke.mjs` mints a session for `ADMIN_EMAIL`). Not read by the running app. |
| `NOPM_API_URL` | Base URL the `nopm` CLI / MCP server call. Also settable per-invocation via `nopm auth set-token`. |
| `NOPM_TOKEN` | A scoped `npm_…` PAT for CLI/MCP use — mint one from the console's Settings → API Tokens once you have an admin login (see step 6). |
| `NOPM_DEMO_LLM_PROVIDER` / `NOPM_DEMO_LLM_KEY` / `NOPM_DEMO_LLM_MODEL` | Optional, server-only. An owner-funded LLM key so the BYOK assistant works on the public demo without a visitor pasting their own key. Rate-limited server-side. Leave unset to disable. |

### 4. Supabase project setup
1. [supabase.com](https://supabase.com) → New project. Any region works; NoPM's own live project runs `ap-southeast-1`.
2. Set and record the database password at creation time — that's `SUPABASE_DB_PASSWORD`.
3. Project Settings → API → copy the Project URL, `anon` key, and `service_role` key into the three Supabase variables above.
4. Nothing else to configure by hand — schema, RLS, and indexes all come from the migrations in step 5.

### 5. Apply migrations
From `web/`:
```bash
node scripts/migrate.mjs
```
This derives `DB_URL` from your Supabase env if you didn't set it directly, then delegates to `scripts/apply-migrations.mjs`, which applies every file in `web/supabase/migrations/` **in filename order**, each wrapped in its own transaction, recording success in a `_nopm_migrations` ledger table (`name text primary key, applied_at`) so re-runs skip already-applied files. All migrations are forward-only — see [03-ROLLBACK.md](03-ROLLBACK.md).

### 6. First admin + seed data
Migrations create schema only — no workspace, no login user. Two scripts, **in this order**:

```bash
node scripts/bootstrap.mjs   # 1) creates the demo workspace + first admin login + two scoped PATs
npm run seed:all             # 2) populates the demo dataset (needs the workspace bootstrap created)
```
`scripts/bootstrap.mjs` upserts a workspace (slug `demo`), creates/reuses an admin login user (`admin@stillnotbald.com`, password from `ADMIN_PASSWORD`), and mints two scoped PATs (a "maker" and a "checker" — the second actor needed to demo maker-checker), appending them to `.env.local` as `NOPM_MAKER_TOKEN` / `NOPM_CHECKER_TOKEN` / `NOPM_WORKSPACE_ID`. **`npm run seed:all` requires this workspace + admin profile to already exist** — `web/scripts/seed.mjs` looks one up with `.single()` and throws on a project with zero workspaces, so running `seed:all` before `bootstrap.mjs` fails on a genuinely fresh database. `seed:all` itself chains `seed.mjs → seed-members.mjs → seed-approvals.mjs → seed-change-control.mjs → seed-people-link.mjs → seed-documents.mjs → seed-document-files.mjs → seed-baselines.mjs → seed-mainline-deps.mjs` (see `web/package.json`).

**Setting your own workspace slug/name (enterprise install).** The workspace `bootstrap.mjs` creates is not hardcoded to the shipped `demo` slug — it reads `NOPM_WORKSPACE_SLUG` / `NOPM_WORKSPACE_NAME` from the environment, defaulting to `demo` / `StillNotBald Programme Office` when unset (so the demo/local flow above is unchanged if you don't set them):

```bash
NOPM_WORKSPACE_SLUG=acme NOPM_WORKSPACE_NAME="Acme Corp" ADMIN_PASSWORD=<a-real-password> \
node scripts/bootstrap.mjs
```

Reading the script (`web/scripts/bootstrap.mjs`) to describe truthfully what it does: it looks up a workspace by the resolved slug and creates it (`workspaces.insert`) if none exists; it then creates a Supabase Auth user (or reuses one that already exists) and upserts a `profiles` row for that user with `role: 'admin'` against the resolved workspace — that upsert is the "first admin" step, not a separate invite. It finally wipes and re-mints two scoped demo PATs named `"maker (agent)"` / `"checker (agent)"`; on a real enterprise install you'll typically mint your own named tokens from `/tokens` afterward (see [`user-manual/admin/01-workspace-admin.md`](../user-manual/admin/01-workspace-admin.md)) rather than keep the demo-labelled pair.

**Known gap, stated honestly:** the first admin's **identity** (`admin@stillnotbald.com`, display name "Jordan Hale") is still hardcoded in `scripts/bootstrap.mjs` — only the workspace slug/name became configurable in this wave. `ADMIN_PASSWORD` is env-driven, but the email/display-name are not; an enterprise install gets its own workspace but reuses the same admin login address unless the script is edited further. Track making the admin identity env-configurable too as a follow-up, not something already shipped here.

### 7. Run it
```bash
npm run dev   # http://localhost:3000
```

### 8. First verification
```bash
curl http://localhost:3000/api/health          # expect {"data":{"status":"ok",...}}
node scripts/auth-smoke.mjs                     # authed page-render rehearsal
```
`auth-smoke.mjs` defaults to `BASE=https://stillnotbald.com`; for a local/self-hosted install run `BASE=http://localhost:3000 node scripts/auth-smoke.mjs`. It mints a real admin session server-side (Supabase `generateLink` + `verifyOtp` — no password typed) and fetches all 19 console pages as that admin, catching server-component render errors an unauthenticated probe misses (see memory: live-authenticated-rehearsal). A clean install should print `19/19` (see [05-GO-NO-GO.md](05-GO-NO-GO.md) gate HG-3).

For the full local gate (typecheck + unit tests + RTM + generated metrics + CLI contract tests), see `.githooks/pre-push` or `.github/workflows/ci.yml`.

---

## Self-hosted path — **STUB**

Self-hosting NoPM against your own Postgres (docker-compose Supabase, or a bare Postgres + separately-run Auth) is **not documented or shipped in this wave**. The schema itself is portable (plain SQL in `web/supabase/migrations/`, no Supabase-managed extensions beyond `pgcrypto`/`uuid-ossp`-style helpers used elsewhere in this codebase), but there is no self-hosted install script, no compose file, and no verified self-hosted RLS/Auth parity check.

**Wave-3 commitment:** a self-hosted install path (top-level `infra/` — self-hosted Supabase docker-compose, a self-hosted backup script, and a version-drift compatibility check as a named verification step) ships in Wave 3, per the owner-resolved Decision 7 in `requirements/devops-wave1/README.md`. Until then, the managed (Supabase + Vercel) path above is the only supported install.

---

**Signature**

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner | | | |
| Client witness (optional) | | | |

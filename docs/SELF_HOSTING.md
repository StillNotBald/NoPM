# Self-hosting NoPM

**Status: the app itself is self-hostable today (R-88, 2026-09-07)** — Docker, a Vercel one-click button, and a one-command `npm run setup` all exist and are exercised below. What remains **documented, not shipped** (deliberate scope decision 2026-08-15, unchanged) is the *deeper* shape: replacing managed Supabase itself with your own Postgres + Auth + Realtime stack. See [`docs/adr/0010-f3-deferral-and-infra-as-documentation.md`](adr/0010-f3-deferral-and-infra-as-documentation.md) for why that deeper layer stays a documented sketch, and "Further self-hosting" below for its detail.

In short: **you still need a Supabase project** (the free tier is enough) — self-hosting here means running the NoPM Next.js app itself wherever you like, against that Supabase project, instead of on the maintainer's Vercel account.

This elaborates — but does not replace — the existing self-hosted **STUB** sections already on record:
[`CUTOVER/01-INSTALL.md`](../CUTOVER/01-INSTALL.md) §"Self-hosted path" and [`CUTOVER/04-BACKUP-RESTORE.md`](../CUTOVER/04-BACKUP-RESTORE.md) §"Self-hosted path". Those remain the canonical status statements; this file is the detail behind them. No self-hosted backup/restore script exists yet — see [`docs/DR_RUNBOOK.md`](DR_RUNBOOK.md).

## Today's actual (maintainer's) deployment, for contrast

The live **stillnotbald.com** instance runs **Vercel** (Next.js host) + **Supabase-managed** (Postgres + Auth + Realtime + RLS) + **Cloudflare** (DNS). Nothing below is required to run *that* product — it's for anyone who wants their own copy of NoPM.

## Fastest path: Vercel button + `npm run setup`

1. Create a Supabase project (free tier): [supabase.com](https://supabase.com) → **New project**. Note the **Project URL**, **anon key**, and **service_role key** (Project Settings → API), and the **database password** (Project Settings → Database).

2. Click:

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/StillNotBald/NoPM&root-directory=web&project-name=nopm&env=NEXT_PUBLIC_SUPABASE_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY,SUPABASE_SERVICE_ROLE_KEY,NOPM_ENCRYPTION_KEY&envDescription=Supabase+project+values+plus+a+generated+BYOK+encryption+key&envLink=https://github.com/StillNotBald/NoPM/blob/main/docs/SELF_HOSTING.md)

   This forks/imports the repo into your own Vercel account, sets the root directory to `web/`, and prompts for the four env vars the running app actually reads at request time:
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NOPM_ENCRYPTION_KEY` (generate the last one with `openssl rand -base64 32`). Vercel builds and deploys — the app comes up, but the database is still empty.

3. Once, from a clone of the repo on your machine (this step needs direct Postgres access, which Vercel's build step doesn't have — it isn't part of the deploy itself):
   ```bash
   git clone https://github.com/StillNotBald/NoPM.git && cd NoPM
   npm install --prefix web
   NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key> \
   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
   SUPABASE_DB_PASSWORD=<db-password> \
   NOPM_ENCRYPTION_KEY=<same-key-you-gave-vercel> \
   ADMIN_EMAIL=you@example.com \
   ADMIN_PASSWORD=<pick-one> \
     npm run setup            # add --seed for sample data, --dry-run to preview first
   ```
   This applies every migration, reloads PostgREST's schema cache (a hard-won lesson on this project: after DDL, PostgREST keeps serving its stale cached schema — without an explicit reload, API calls against a table that just got created come back empty or 404 instead of erroring loudly), and creates your admin login plus a demo maker/checker token pair. It prints the app URL and next steps; it never prints the admin password or any secret back to the terminal beyond a masked preview in `--dry-run`.
4. Sign in at your Vercel URL with the admin email/password you chose, or mint a scoped token under **Settings → API Tokens** to connect an agent (CLI, MCP, or the BYOK assistant).

Re-running `npm run setup` against the same project is safe — migrations skip what's already applied, and bootstrap upserts the workspace/admin/tokens rather than duplicating them.

## Docker

> Note: `docker compose config` prints every value from `env_file`, including your service-role key, to the terminal. Use `docker compose config --quiet` to validate, and never paste the full output anywhere.

Run the Next.js app in a container, against the same hosted Supabase project (a fully local Supabase stack is out of scope — see the `supabase start` note below):

```bash
cd web
docker build -t nopm-web .          # builds a ~300 MB standalone image
docker run -p 3000:3000 \
  -e NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
  -e NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key> \
  -e SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
  -e NOPM_ENCRYPTION_KEY=<base64-32-bytes> \
  nopm-web
```

`NEXT_PUBLIC_*` values are inlined into the client JavaScript bundle at **build** time (a Next.js constraint, not a NoPM one) — pass your real project's URL/anon key as `--build-arg` if you know them upfront, or accept the placeholder defaults and rebuild later:
```bash
docker build -t nopm-web \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key> \
  .
```
Server-only vars (`SUPABASE_SERVICE_ROLE_KEY`, `NOPM_ENCRYPTION_KEY`, ...) are read at request time and only need to be set on `docker run` / in your compose file, not at build time.

Or, from the repo root, with `docker-compose.yml`:
```bash
cp web/.env.example web/.env.local   # fill in your Supabase project's values
docker compose up --build
```
Run `npm run setup` once against your Supabase project first (as in the fastest-path section above) — the container serves the app, it does not apply migrations.

Want Postgres/Auth/Realtime running locally too, instead of Supabase Cloud? Use the Supabase CLI's own compose setup (`npx supabase start`) and point the env vars above at that instead — this repo's `docker-compose.yml` deliberately doesn't duplicate that stack (see "Further self-hosting" below for why a from-scratch version is documented, not shipped).

### Behind a reverse proxy: `NOPM_TRUSTED_PROXY_HOPS`

A few endpoints are rate-limited per caller address **before** anyone is authenticated: accepting an invite (`POST /api/invites/accept`), the Lark relay, and failed webhook signature checks. The app cannot see the socket address, and `X-Forwarded-For` is a header the caller can write, so **off Vercel nothing is trusted by default**. Until you say otherwise:

- invite-accept puts **every caller in one shared bucket** (10 attempts a minute in total), so anyone sending junk can keep a genuine invitee from accepting;
- the Lark relay skips its per-address cap and leans on the signature check and the per-connector cap.

The app logs a one-time warning the first time a request needs the address and none can be trusted. To fix it, set `NOPM_TRUSTED_PROXY_HOPS` to the number of reverse proxies **you** run in front of the app: `1` for a single nginx, Caddy or cloud load balancer, `2` for a CDN plus a load balancer, and so on. The address is then read from the right of `X-Forwarded-For` (each proxy you run appends the peer it saw), never from the caller's own first entry.

```bash
docker run -p 3000:3000 -e NOPM_TRUSTED_PROXY_HOPS=1 ... nopm-web      # nginx / Caddy in front
# docker compose: add NOPM_TRUSTED_PROXY_HOPS=1 to web/.env.local
```

Leave it unset if you publish the container's port straight to the internet with no proxy (there is no trustworthy header to read). Do not set it higher than the proxies you really run: a number that is too high lets the caller choose its own address. It has no effect on Vercel, which supplies the address itself.

## Manual

Clone, `npm install --prefix web`, copy `web/.env.example` to `web/.env.local` and fill it in, then `npm run migrate` and `node web/scripts/bootstrap.mjs` (or the combined `npm run setup`), then `npm run dev` / `npm run build && npm start`. The step-by-step version, written for someone who has never used Supabase or Next.js, with a full env-variable glossary and a troubleshooting section, lives in [`docs/guide/02-run-it-yourself.md`](guide/02-run-it-yourself.md) — start there if the fast paths above skip a step you need spelled out. Running behind nginx, Caddy or a load balancer? Set `NOPM_TRUSTED_PROXY_HOPS` as described under Docker above.

## Further self-hosting: replacing Supabase itself

Everything above still depends on a **hosted Supabase project**. This section is for someone who additionally wants to run Postgres, Auth, and Realtime themselves — genuinely un-shipped, sketch only (ADR 0010).

### 1. Topology sketch

A self-hosted install would need a Supabase-equivalent stack sitting in front of plain Postgres, plus the Next.js app itself:

```
┌─────────────────────────────────────────────────────────────────┐
│                         docker-compose                          │
│                                                                   │
│  ┌──────────┐   ┌───────────┐   ┌────────────┐   ┌────────────┐  │
│  │  web     │──▶│  kong     │──▶│  postgrest │──▶│  postgres  │  │
│  │ (Next.js,│   │ (API      │   │ (PostgREST │   │ (schema =  │  │
│  │  this    │   │  gateway) │   │  — REST-   │   │  web/      │  │
│  │  repo)   │   │           │   │  over-SQL) │   │  supabase/ │  │
│  └──────────┘   └───────────┘   └────────────┘   │  migrations│  │
│       │               │                            │  as-is)   │  │
│       │               ├──▶ gotrue    (Auth)        └────────────┘  │
│       │               ├──▶ realtime  (Postgres logical replication │
│       │               │              → websocket fan-out)          │
│       │               └──▶ storage   (not used by NoPM today —     │
│       │                              no file-upload feature ships) │
│       │                                                            │
│       └── talks to postgrest/gotrue/realtime the same way the     │
│           hosted Supabase client does today (`@supabase/ssr`,     │
│           `@supabase/supabase-js` — no code change, only the URL) │
└─────────────────────────────────────────────────────────────────┘
```

Notes on this sketch:
- NoPM's own app code (`web/`) does **not** talk to Postgres directly anywhere except the migration runner (`scripts/migrate.mjs` / `scripts/apply-migrations.mjs`) and ops scripts (seeders, `auth-smoke.mjs`). Every request path goes through `@supabase/ssr` / `@supabase/supabase-js`, which means the self-hosted Supabase stack (`kong` + `postgrest` + `gotrue` + `realtime`) is a drop-in replacement for the managed one **as far as the app is concerned** — the schema (`web/supabase/migrations/`) is plain SQL with no Supabase-managed-only extensions beyond `pgcrypto`/`uuid-ossp`-style helpers already used elsewhere in this codebase (confirmed in `CUTOVER/01-INSTALL.md`).
- `storage` is included in the sketch for topology completeness only — NoPM ships no file-upload feature, so it is not a dependency in practice.
- This sketch has **not been stood up or verified**. It is derived from the public self-hosted Supabase reference architecture, not from a working NoPM deployment against it. Treat every box above as "expected to work because the app only ever talks through the standard Supabase client libraries," not "proven to work."

### 2. Env matrix

What each `.env.local` variable (see `web/.env.example`) would mean under self-hosting, vs. its managed-path meaning today:

| Variable | Managed (today) | Self-hosted (documented shape) |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` | `http://<your-kong-host>:8000` (or wherever `kong` is exposed) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase dashboard → Project API keys | The `ANON_KEY` you generate/configure for your self-hosted `gotrue`/`postgrest` (Supabase's self-host guide documents key generation — out of scope for this file) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard | The `SERVICE_ROLE_KEY` you configure for the same self-hosted stack — still server-only, still bypasses RLS, still never exposed to the client |
| `SUPABASE_DB_PASSWORD` | Supabase-managed Postgres password | Your own Postgres password |
| `DB_URL` | Derived by `scripts/migrate.mjs` from the two vars above, or set directly | Set directly — any reachable Postgres connection string works (`scripts/migrate.mjs` / `apply-migrations.mjs` have no Supabase-specific logic beyond the URL-derivation convenience, which self-hosting bypasses by setting `DB_URL` explicitly) |
| `NEXT_PUBLIC_APP_URL` | `https://stillnotbald.com` | Your own app URL |
| `NOPM_TOKEN_PREFIX`, `NOPM_ENCRYPTION_KEY` | Unchanged — app-level, no Supabase dependency | Unchanged |
| `DEMO_EMAIL` / `DEMO_PASSWORD`, `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Unchanged — created via `gotrue`/Auth either way | Unchanged, but the accounts must exist in your self-hosted `gotrue` instance |
| `NOPM_API_URL`, `NOPM_TOKEN` (CLI/MCP) | Unchanged | Unchanged — points at whatever `NEXT_PUBLIC_APP_URL` is |
| `NOPM_DEMO_LLM_*` | Owner-funded demo-only; irrelevant to a self-host operator | Same — optional, unrelated to hosting mode |

No new environment variables would be needed beyond what `web/.env.example` already documents — self-hosting is a matter of **where the existing variables point**, not new configuration surface.

### 3. Migration path

The migration runner is already host-agnostic:

```bash
cd web
DB_URL=postgresql://<user>:<password>@<host>:5432/<db> node scripts/migrate.mjs
```

`scripts/migrate.mjs` derives `DB_URL` from `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_DB_PASSWORD` only as a managed-path convenience; setting `DB_URL` directly (as above) skips that derivation entirely and applies every migration in `web/supabase/migrations/` in order against **any** reachable Postgres — self-hosted or otherwise. This is the same script the managed path uses; there is no separate self-host migration tool to build.

### 4. What is NOT supported self-hosted (honest gaps)

- **Realtime bell degrades.** `web/src/components/notifications/bell.tsx` subscribes to Supabase Realtime (websocket fan-out over Postgres logical replication) for live in-app notifications. Supabase-managed Realtime is pre-wired; the self-hosted `realtime` container needs its own replication-slot and publication configuration to match. Undocumented/misconfigured, the bell does not error — it simply stops receiving live updates and falls back to whatever was last fetched. No code change would be needed if `realtime` is configured correctly; this repo has not verified that configuration.
- **Vercel-specific bits.** Preview-deploy-per-PR, edge/serverless function behavior, and Vercel's own env/secret management are Vercel-specific conveniences with no self-hosted equivalent documented here — a self-hosted install runs the Next.js app as a plain Node server (`next build && next start`, already in `web/package.json`) behind whatever reverse proxy the operator chooses.
- **No self-hosted backup/restore script or drill.** Backup posture (managed-path PITR, self-hosted gap) is covered in [`docs/DR_RUNBOOK.md`](DR_RUNBOOK.md) and [`CUTOVER/04-BACKUP-RESTORE.md`](../CUTOVER/04-BACKUP-RESTORE.md). Do not run a self-hosted NoPM against data you cannot afford to lose.
- **No self-hosted RLS/Auth parity check.** The migrations create the same RLS policies either way, but nothing in this repo has verified that a self-hosted `gotrue` issues JWTs with the claims NoPM's RLS policies (`nopm_current_workspace()`, etc.) expect, byte-for-byte identically to managed Supabase Auth.

## Relationship to the F3 deferral

The F3 deferral (ADR 0010, 2026-08-15) was about the *deeper* layer covered in "Further self-hosting" above — replacing managed Supabase itself with a self-run `kong` + `postgrest` + `gotrue` + `realtime` stack. That decision is unchanged: this document — and [`docs/DR_RUNBOOK.md`](DR_RUNBOOK.md) — remain that layer's deliverable in documented-sketch form, not stood-up code. What changed with R-88 (2026-09-07) is the layer above it: running the NoPM **app** itself (Docker, Vercel, `npm run setup`) against a still-hosted Supabase project was always in scope and is now shipped. See [`docs/adr/0010-f3-deferral-and-infra-as-documentation.md`](adr/0010-f3-deferral-and-infra-as-documentation.md).

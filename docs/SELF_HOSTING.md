# Self-hosting NoPM

**Status: DOCUMENTED, NOT SHIPPED — deliberate scope decision 2026-08-15.**
No docker-compose file, no self-host install script, and no self-hosted backup script exist in this repo. This document specifies the *shape* a self-hosted install would take, so the decision to defer it is a reasoned one rather than a silent gap. See [`docs/adr/0010-f3-deferral-and-infra-as-documentation.md`](adr/0010-f3-deferral-and-infra-as-documentation.md) for why.

This elaborates — but does not replace — the existing self-hosted **STUB** sections already on record:
[`CUTOVER/01-INSTALL.md`](../CUTOVER/01-INSTALL.md) §"Self-hosted path" and [`CUTOVER/04-BACKUP-RESTORE.md`](../CUTOVER/04-BACKUP-RESTORE.md) §"Self-hosted path". Those remain the canonical status statements; this file is the detail behind them.

## Today's actual deployment (for contrast)

NoPM runs **Vercel** (Next.js host) + **Supabase-managed** (Postgres + Auth + Realtime + RLS) + **Cloudflare** (DNS). Nothing below is required to run the live product — it is only relevant to someone who wants to run NoPM against their own infrastructure.

## 1. Topology sketch (self-hosted shape)

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

## 2. Env matrix

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

## 3. Migration path

The migration runner is already host-agnostic:

```bash
cd web
DB_URL=postgresql://<user>:<password>@<host>:5432/<db> node scripts/migrate.mjs
```

`scripts/migrate.mjs` derives `DB_URL` from `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_DB_PASSWORD` only as a managed-path convenience; setting `DB_URL` directly (as above) skips that derivation entirely and applies every migration in `web/supabase/migrations/` in order against **any** reachable Postgres — self-hosted or otherwise. This is the same script the managed path uses; there is no separate self-host migration tool to build.

## 4. What is NOT supported self-hosted (honest gaps)

- **Realtime bell degrades.** `web/src/components/notifications/bell.tsx` subscribes to Supabase Realtime (websocket fan-out over Postgres logical replication) for live in-app notifications. Supabase-managed Realtime is pre-wired; the self-hosted `realtime` container needs its own replication-slot and publication configuration to match. Undocumented/misconfigured, the bell does not error — it simply stops receiving live updates and falls back to whatever was last fetched. No code change would be needed if `realtime` is configured correctly; this repo has not verified that configuration.
- **Vercel-specific bits.** Preview-deploy-per-PR, edge/serverless function behavior, and Vercel's own env/secret management are Vercel-specific conveniences with no self-hosted equivalent documented here — a self-hosted install runs the Next.js app as a plain Node server (`next build && next start`, already in `web/package.json`) behind whatever reverse proxy the operator chooses.
- **No self-hosted backup/restore script or drill.** Backup posture (managed-path PITR, self-hosted gap) is covered in [`docs/DR_RUNBOOK.md`](DR_RUNBOOK.md) and [`CUTOVER/04-BACKUP-RESTORE.md`](../CUTOVER/04-BACKUP-RESTORE.md). Do not run a self-hosted NoPM against data you cannot afford to lose.
- **No self-hosted RLS/Auth parity check.** The migrations create the same RLS policies either way, but nothing in this repo has verified that a self-hosted `gotrue` issues JWTs with the claims NoPM's RLS policies (`nopm_current_workspace()`, etc.) expect, byte-for-byte identically to managed Supabase Auth.

## Relationship to the F3 deferral

This document — and [`docs/DR_RUNBOOK.md`](DR_RUNBOOK.md) — **are** Wave 3's deliverable in its current, owner-accepted form: infra becomes documentation, not docker-compose code. See [`docs/adr/0010-f3-deferral-and-infra-as-documentation.md`](adr/0010-f3-deferral-and-infra-as-documentation.md).

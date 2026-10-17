# PROD_DOOR — what is production, right now

**Status: ACTIVE**

This is the one file that answers "what is live and where does it live" as a snapshot in time. Rows that can drift carry a **link to the file that owns the value**, not a copy of the value — if this table and the linked file ever disagree, the linked file wins and this row is stale (fix the row, don't trust it).

**Do NOT hand-copy values out of this table into anything else.** Every downstream doc, deck, or conversation should link back here (or to the owning file directly), never paste the current value — that's exactly how facts drift out of sync.

## The table

| Fact | Current value | Owning source (never copied, only pointed at) |
|---|---|---|
| Platform | Vercel | `web/.vercel/project.json` (`projectName` only — IDs/org/project secrets never appear here) |
| Serving URL | stillnotbald.com | [`README.md`](../../README.md), `docs/adr/0001-stack-host-scope.md` |
| DNS | Cloudflare | `docs/adr/0001-stack-host-scope.md` (DNS only — no Workers/OpenNext) |
| Database | Supabase project `nopm`, region `ap-southeast-1` | `CLAUDE.md` → Commands section; connection ref lives in `web/.env.local` (`NEXT_PUBLIC_SUPABASE_URL` / `DB_URL` — gitignored, never copy the value out) |
| Migration head | Live ledger: 0001–0044 (last in order `20260906000044_rpc_audit_provenance.sql`) plus `20261016000048_rls_api_only_writes.sql`, applied out of order as a hotfix on 2026-10-17. Written but NOT yet applied: 0045–0047 and 0049–0054 (the lark wave; its code is not deployed either). After the rollout the head is `20261017000054_lifecycle_guards_2.sql` | `_nopm_migrations` ledger on the live database; `web/supabase/migrations/` (latest filename by timestamp prefix — re-run `ls web/supabase/migrations/` to check currency, this row is a snapshot); rollout steps in [`CUTOVER/07-LARK-WAVE-ROLLOUT.md`](../../CUTOVER/07-LARK-WAVE-ROLLOUT.md) |
| Secrets | `web/.env.local` (gitignored) + Vercel project env vars | `web/.env.example` (documents every key's purpose, never a real value) |
| Rate limiting | Enabled, DB-backed fixed-window, fail-open on limiter-infra error / fail-closed (429) on an actual hit. Defaults: **600 reads/min, 120 writes/min**, keyed per `workspace_id + actor type (user/token) + read-or-write bucket` | `web/src/lib/api/rate-limit.ts`, migration `20260814000029_rate_limiting.sql`; env-overridable via `NOPM_RATE_READ_PER_MIN` / `NOPM_RATE_WRITE_PER_MIN` |
| Public posture | Demo login (`POST /api/auth/demo-login`) into a single shared, writable demo workspace — no signup | [`README.md`](../../README.md) "Three agent surfaces" intro, `requirements/REQUIREMENTS.md` R-53 |
| Email | Demo-previews only — rendered, never sent. Resend stays demo-mode | `CLAUDE.md` Sanctioned section (R-27), `SECURITY.md` |
| Crons (scheduled workflows) | `e2e-smoke.yml` — **weekly**, Mondays 21:00 UTC (also the demo keep-alive against Supabase free-tier pause). `reseed.yml` exists but is **manual-only** (`workflow_dispatch` / `gh workflow run`) by owner decision 2026-07-12 — no schedule trigger is currently wired | `.github/workflows/e2e-smoke.yml`, `.github/workflows/reseed.yml` (see that file's own header for the re-enable-nightly instructions) |
| Integration scheduler (Vercel Cron) | **Daily**, 01:07 UTC, `GET /api/integrations/cron`, authenticated by `Authorization: Bearer $CRON_SECRET` (set `CRON_SECRET` in the Vercel project env; Vercel attaches it). It retries due Lark deliveries (the floor under traffic-driven retries), sends each connector's weekly digest, and prunes old bookkeeping rows. With `CRON_SECRET` unset the endpoint refuses every call: approval cards still send, but the digest never sends on its own and nothing is pruned | `web/vercel.json` (`crons`), `web/src/app/api/integrations/cron/route.ts`, `web/.env.example` (`CRON_SECRET`) |
| Client-address trust (self-host) | **Nothing is trusted by default.** On Vercel the platform supplies the client address; anywhere else set `NOPM_TRUSTED_PROXY_HOPS` to the number of reverse proxies you run in front of the app, or the per-address caps (Lark relay, invite accept, failed webhook verifications) are skipped or share one bucket | `web/src/lib/api/client-ip.ts`, `web/.env.example` |
| Integration throttles (env-overridable) | Calendar feed: **60/min per feed** (`NOPM_RATE_CAL_PER_MIN`) and **120/min per client address** (`NOPM_RATE_CAL_IP_PER_MIN`). Lark webhook, authenticated: **300/min per connector** (`NOPM_RATE_LARK_PER_MIN`). Same DB-backed counter as the baseline limiter | `web/src/lib/calendar/feeds.ts`, `web/src/lib/integrations/lark/http.ts`, `web/.env.example` |
| Test-only switches | `NOPM_LARK_API_BASE_OVERRIDE` (points the Lark client at a local fake) and `NOPM_ALLOW_LARK_OVERRIDE` (lets that override work when `NODE_ENV=production`). **TEST ONLY — must be unset in production.** Without `NOPM_ALLOW_LARK_OVERRIDE=1` a production build ignores the override entirely | `web/src/lib/integrations/lark/client.ts`, `web/.env.example` |
| Demoted doors | None | — no prior production platform/URL/DB has been retired; this is the only production door that has ever existed for NoPM |

## Before you deploy a build that contains the Lark / principal four-eyes work

**Apply migrations 0045 to 0054 to the target database FIRST, in order, then deploy the code.** They are:

| # | File (in `web/supabase/migrations/`) | What the code depends on |
|---|---|---|
| 0045 | `20261016000045_principal_four_eyes.sql` | the human behind each requester and decider (principal columns and checks), principal-aware deletion-commit RPCs (the old overloads are dropped) |
| 0046 | `20261016000046_integration_hub.sql` | connectors, identities, link codes, deliveries, action tokens; `audit_log.channel = lark` and the connector provenance columns |
| 0047 | `20261016000047_calendar_feeds.sql` | revocable calendar feeds |
| 0048 | `20261016000048_rls_api_only_writes.sql` | the API is the only writer of governed data (direct-write RLS policies removed) |
| 0049 | `20261017000049_lifecycle_guards.sql` | database backstops: locked-project dates, timesheet week lock and content digest, rebaseline lifecycle, project-deletion child counts |
| 0050 | `20261017000050_truncate_guard.sql` | `audit_log` immutability now covers TRUNCATE (also fixes `nopm_rate_check`) |
| 0051 | `20261017000051_hub_reliability.sql` | one scheduled digest per connector per week, retention and health indexes, `integration_cron_state` |
| 0052 | `20261017000052_api_tokens_kind.sql` | `api_tokens.kind` (the assistant's ephemeral tokens are hidden by kind, not by name) |
| 0053 | `20261017000053_hub_card_integrity.sql` | action tokens bound to the request's content version (a card can only approve what it showed) |
| 0054 | `20261017000054_lifecycle_guards_2.sql` | project-deletion scope guard counts every table that cascades from a project (15 keys); write and `MAINTAIN` privileges revoked from the API roles on the deny-all tables |

The code reads and writes columns, tables and triggers these create, so a build deployed ahead of them fails governed writes (deletion approvals first). The reverse also bites: 0045 drops the old commit-RPC overloads, so the PREVIOUS build's deletion approvals fail once it has been applied. Treat "apply 0045-0054, then deploy" as one change window, not two separate days. Migrations are forward-only (`_nopm_migrations` ledger); there is no down path, so take a restore point first and read [`CUTOVER/03-ROLLBACK.md`](../../CUTOVER/03-ROLLBACK.md) before you start. The new environment variables are in `web/.env.example` (see the rows above). The step-by-step runbook (pre-check, one-transaction apply with `migrate.mjs --atomic`, a build that is not aliased until the post-check passes, then promote) is [`CUTOVER/07-LARK-WAVE-ROLLOUT.md`](../../CUTOVER/07-LARK-WAVE-ROLLOUT.md); 0048 is already live and is skipped by name.

## Notes on rows that need a second look

- **Reseed is not a cron today.** If you're told "weekly reseed" from memory or an older doc, that's stale — `reseed.yml`'s own header explains it was deliberately turned off (demo not yet shared broadly) and shows the exact `schedule:` block to restore if that changes. Only `e2e-smoke.yml` runs on a schedule.
- **Migration head moves.** A parallel wave can add a new file to `web/supabase/migrations/` at any time; treat the value above as "true as of this write," and re-derive it (`ls web/supabase/migrations/` sorted, take the highest timestamp prefix) rather than trusting this row indefinitely.
- **Rollback ≠ down-migration.** There is no down-migration path (forward-only, `web/scripts/apply-migrations.mjs`, `_nopm_migrations` ledger). DB rollback is restore-from-backup only, and must never restore past the oldest deployed build's migration head (version-skew rule) — see [`CUTOVER/03-ROLLBACK.md`](../../CUTOVER/03-ROLLBACK.md) for the decision table.

## Links, not copies

- Full install/deploy procedure: [`CUTOVER/`](../../CUTOVER/README.md)
- Test evidence for what's currently proven live: [`testing-log/`](../../testing-log/README.md)
- System-level architecture (how the pieces above fit together): [`system_architecture.md`](../architecture/system_architecture.md)

---

**Signature**

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner (table verified current) | | | |
| Client witness (optional) | | | |

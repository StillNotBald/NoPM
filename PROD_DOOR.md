# PROD_DOOR — what is production, right now

**Status: ACTIVE**

This is the one file that answers "what is live and where does it live" as a snapshot in time. Rows that can drift carry a **link to the file that owns the value**, not a copy of the value — if this table and the linked file ever disagree, the linked file wins and this row is stale (fix the row, don't trust it).

**Do NOT hand-copy values out of this table into anything else.** Every downstream doc, deck, or conversation should link back here (or to the owning file directly), never paste the current value — that's exactly how facts drift out of sync.

## The table

| Fact | Current value | Owning source (never copied, only pointed at) |
|---|---|---|
| Platform | Vercel | `web/.vercel/project.json` (`projectName` only — IDs/org/project secrets never appear here) |
| Serving URL | stillnotbald.com | [`README.md`](README.md), `docs/adr/0001-stack-host-scope.md` |
| DNS | Cloudflare | `docs/adr/0001-stack-host-scope.md` (DNS only — no Workers/OpenNext) |
| Database | Supabase project `nopm`, region `ap-southeast-1` | `CLAUDE.md` → Commands section; connection ref lives in `web/.env.local` (`NEXT_PUBLIC_SUPABASE_URL` / `DB_URL` — gitignored, never copy the value out) |
| Migration head | `20260814000032_project_deletion_four_eyes.sql` | `web/supabase/migrations/` (latest filename by timestamp prefix — re-run `ls web/supabase/migrations/` to check currency, this row is a snapshot) |
| Secrets | `web/.env.local` (gitignored) + Vercel project env vars | `web/.env.example` (documents every key's purpose, never a real value) |
| Rate limiting | Enabled, DB-backed fixed-window, fail-open on limiter-infra error / fail-closed (429) on an actual hit. Defaults: **600 reads/min, 120 writes/min**, keyed per `workspace_id + actor type (user/token) + read-or-write bucket` | `web/src/lib/api/rate-limit.ts`, migration `20260814000029_rate_limiting.sql`; env-overridable via `NOPM_RATE_READ_PER_MIN` / `NOPM_RATE_WRITE_PER_MIN` |
| Public posture | Demo login (`POST /api/auth/demo-login`) into a single shared, writable demo workspace — no signup | [`README.md`](README.md) "Three agent surfaces" intro, `requirements/REQUIREMENTS.md` R-53 |
| Email | Demo-previews only — rendered, never sent. Resend stays demo-mode | `CLAUDE.md` Sanctioned section (R-27), `SECURITY.md` |
| Crons (scheduled workflows) | `e2e-smoke.yml` — **weekly**, Mondays 21:00 UTC (also the demo keep-alive against Supabase free-tier pause). `reseed.yml` exists but is **manual-only** (`workflow_dispatch` / `gh workflow run`) by owner decision 2026-07-12 — no schedule trigger is currently wired | `.github/workflows/e2e-smoke.yml`, `.github/workflows/reseed.yml` (see that file's own header for the re-enable-nightly instructions) |
| Demoted doors | None | — no prior production platform/URL/DB has been retired; this is the only production door that has ever existed for NoPM |

## Notes on rows that need a second look

- **Reseed is not a cron today.** If you're told "weekly reseed" from memory or an older doc, that's stale — `reseed.yml`'s own header explains it was deliberately turned off (demo not yet shared broadly) and shows the exact `schedule:` block to restore if that changes. Only `e2e-smoke.yml` runs on a schedule.
- **Migration head moves.** A parallel wave can add a new file to `web/supabase/migrations/` at any time; treat the value above as "true as of this write," and re-derive it (`ls web/supabase/migrations/` sorted, take the highest timestamp prefix) rather than trusting this row indefinitely.
- **Rollback ≠ down-migration.** There is no down-migration path (forward-only, `web/scripts/apply-migrations.mjs`, `_nopm_migrations` ledger). DB rollback is restore-from-backup only, and must never restore past the oldest deployed build's migration head (version-skew rule) — see [`CUTOVER/03-ROLLBACK.md`](CUTOVER/03-ROLLBACK.md) for the decision table.

## Links, not copies

- Full install/deploy procedure: [`CUTOVER/`](CUTOVER/README.md)
- Test evidence for what's currently proven live: [`testing-log/`](testing-log/README.md)
- System-level architecture (how the pieces above fit together): [`system_architecture.md`](system_architecture.md)

---

**Signature**

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner (table verified current) | | | |
| Client witness (optional) | | | |

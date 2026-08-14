# Backup / restore drill

**Status: DRAFT** — this procedure has not been executed against this codebase yet. It is believed correct (built from the mechanisms verified in `web/package.json`, `web/scripts/auth-smoke.mjs`, and `CUTOVER/03-ROLLBACK.md`), but carries no evidence run. Flip to **ACTIVE** only after the first real execution below, once its `testing-log/` entry and signature exist.

This file is the **canonical owner** of the drill's step-by-step procedure. [`CUTOVER/04-BACKUP-RESTORE.md`](../../CUTOVER/04-BACKUP-RESTORE.md) links here rather than restating the steps — if the two ever disagree, this file wins.

## Why this drill exists

A restore path you've never exercised is not a backup strategy — it's a hope. NoPM's DB rollback story is **restore-from-backup only** (migrations are forward-only, `web/scripts/apply-migrations.mjs`, no down-migrations — see `CUTOVER/03-ROLLBACK.md`), which makes this drill the one rehearsal that proves the emergency path actually works before a real cutover needs it.

## Prerequisites

- Supabase CLI (`supabase db dump`) — already a devDependency, see `web/package.json`.
- A **scratch** Supabase project (separate from the live `nopm` project) to restore into. Never run a destructive step 2 against a project you can't afford to lose.
- `web/.env.local` populated for the scratch project (or a second env file you swap in), so `node scripts/auth-smoke.mjs` can be pointed at it via `BASE=`.

## Procedure

1. **Dump.** From `web/`, against the source project (production, or a fresh clone of it):
   ```bash
   supabase db dump --db-url "$DB_URL" -f backup-<YYYY-MM-DD>.sql
   ```
2. **Restore to scratch.** Stand up (or reuse) a scratch Supabase project, then:
   ```bash
   psql "$SCRATCH_DB_URL" -f backup-<YYYY-MM-DD>.sql
   ```
   Confirm the `_nopm_migrations` ledger in the restored DB matches the migrations directory listing (`ls web/supabase/migrations/`) — a mismatch here means the dump was taken mid-migration or the scratch project's schema predates it.
3. **Run auth-smoke against it.**
   ```bash
   BASE=<scratch-project-app-url> node scripts/auth-smoke.mjs
   ```
   A clean restore should print the same page-count result auth-smoke reports against a healthy live target (see [`CUTOVER/01-INSTALL.md`](../../CUTOVER/01-INSTALL.md) step 8) — this is the drill's actual pass/fail signal, not just "the restore command exited 0".
4. **File evidence.** Record the run as a new dated, immutable folder under `testing-log/` — `testing-log/<YYYY-MM-DD>_restore-drill/`, following the conventions in `testing-log/README.md` (a summary README naming what was run, by whom, the dump filename/timestamp, and the auth-smoke result; raw output optional, never large binaries).
5. **Sign the memo.** Complete the signature block below for this run — a dated evidence folder without a signature is not a closed drill.

## Drill log

One row per execution. This table is the index; the dated `testing-log/` folder is the evidence.

| Date | Operator | Dump source | Scratch target | Auth-smoke result | Evidence folder | Signature |
|---|---|---|---|---|---|---|
| | | | | | | |

## Known limitation

This procedure assumes the managed (Supabase-hosted) path only. Self-hosted backup/restore has no drill and no script — it's a Wave-3 stub per `CUTOVER/04-BACKUP-RESTORE.md` and `requirements/devops-wave1/README.md` Decision 7.

---

**Signature**

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner (drill procedure current + last run reviewed) | | | |
| Client witness (optional) | | | |

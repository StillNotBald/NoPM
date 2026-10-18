# 04 · Backup & Restore

**Status: ACTIVE (managed path)** · self-hosted path is a **STUB**

## Managed path (Supabase)

NoPM's database backup surface is entirely Supabase-managed — no bespoke backup script exists or is needed for the managed path.

### Taking a backup
Two equivalent mechanisms:
1. **`supabase db dump`** (Supabase CLI, already a devDependency — see `web/package.json`) — a logical (pg_dump-style) export you can run on demand, before any risky migration or cutover step:
   ```bash
   supabase db dump --db-url "$DB_URL" -f backup-<date>.sql
   ```
2. **Supabase dashboard PITR** (Point-In-Time Recovery, project Settings → Database → Backups) — continuous, automatic on paid tiers; gives a restore-to-any-second window rather than a discrete snapshot. Free-tier projects get daily backups only, not PITR — check the tier before relying on a specific recovery point.

Take an explicit `db dump` immediately before applying any migration you're not fully confident in, even if PITR is also available — a named, timestamped file is easier to reason about under pressure than "somewhere in the PITR window."

### Restoring
1. **PITR**: dashboard → Backups → pick the timestamp → Restore. This is destructive to the current state — it replaces the live database, not a copy. Confirm the [version-skew ordering rule](03-ROLLBACK.md#-version-skew-ordering-rule-boxed-warning) before restoring: don't restore past the oldest deployed build's migration head.
2. **`db dump` file**: restore into a fresh/target Postgres with `psql "$DB_URL" -f backup-<date>.sql` (or the Supabase CLI's own restore path if targeting the same project). Prefer restoring into a scratch project first to verify the dump before pointing production at it, when time allows.

### Restore drill — procedure + evidence

A restore you've never tested is not a backup strategy. The step-by-step drill procedure, its prerequisites, and its evidence/sign-off log are owned by [`docs/runbooks/backup-restore-drill.md`](../docs/runbooks/backup-restore-drill.md) (Status: DRAFT until first executed) — this file does not restate the steps, only points at them. Evidence from an executed drill is filed as a dated folder under **`testing-log/`**, per that runbook and the immutable dated-evidence-folder convention (`testing-log/README.md`).

## Self-hosted path — **STUB**

No self-hosted backup mechanism (script or documented procedure) exists in this wave. A self-hosted Postgres install (docker-compose Supabase or bare Postgres) needs its own `pg_dump`/`pg_basebackup`-based backup script and a documented, drilled restore procedure — neither ships here.

**Wave-3 commitment:** the self-hosted backup script and its restore drill procedure ship in Wave 3 alongside the self-hosted `infra/` docker-compose, per the owner-resolved Decision 7 in `requirements/devops-wave1/README.md`. Until then, self-hosted installs have no supported backup path — do not run a self-hosted NoPM against data you cannot afford to lose.

---

**Signature**

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner (backup/restore drill executed) | | | |
| Client witness (optional) | | | |

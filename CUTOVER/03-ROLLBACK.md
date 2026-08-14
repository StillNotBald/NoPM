# 03 · Rollback

**Status: ACTIVE**

Two independent rollback surfaces — app and database. They are **not symmetric**: app rollback is instant and reversible; database rollback is destructive and slow. Never conflate them.

## App rollback — Vercel instant rollback

For a bad **code** release with no accompanying schema change (or one whose schema change is additive/backward-compatible), roll back the app only:
```bash
vercel rollback            # or: dashboard → Deployments → previous good build → Instant Rollback
```
This re-points the production alias at the previous build in seconds. See [02-DEPLOY.md](02-DEPLOY.md) for the **rollback-freezes-alias gotcha** — a rollback pins the alias until you explicitly `vercel promote` a build again; every deploy after a rollback needs that check.

## Database rollback — restore-from-backup ONLY

> **Migrations are forward-only.** There is no down-migration mechanism in this repo — `web/scripts/apply-migrations.mjs` applies files in order and records them in a `_nopm_migrations` ledger; nothing reverses an applied file. **The only way to undo a bad migration is to restore the database from a backup taken before it was applied.**

See [04-BACKUP-RESTORE.md](04-BACKUP-RESTORE.md) for the restore procedure itself (`supabase db dump` / Supabase dashboard PITR).

### ⚠️ Version-skew ordering rule (boxed warning)

> **Never restore the database past the oldest deployed build's migration head.**
>
> If Build A (expects migrations through `…029`) is still running anywhere — a stale browser tab, a cached edge function, a Vercel deployment you haven't rolled the alias off of — restoring the database to a snapshot taken *before* `…029` was applied will hand Build A a schema it doesn't understand: missing columns, missing tables, broken queries, possibly silent data corruption if a write path assumes a column that no longer exists.
>
> Before any DB restore: confirm (via `vercel ls` / the dashboard) which build currently owns the production alias, read the migration files it expects against `_nopm_migrations`, and only restore to a snapshot at or after that build's migration head. If in doubt, roll the app back to match the database snapshot's migration head *first* (App rollback, above), then restore.

## Decision table — which failure, which rollback

| Failure | App rollback? | DB restore? | Notes |
|---|---|---|---|
| Bad code release, no schema change | Yes | No | Fastest path — `vercel rollback`. |
| Bad code release, additive schema change (new nullable column/table) old code ignores | Yes | No | Old code is backward-compatible by the ordering rule in [02-DEPLOY.md](02-DEPLOY.md); rolling back the app is sufficient. |
| Migration applied cleanly but the new code relying on it is broken | Yes | No | Roll the app back; the schema addition is harmless if unused. Fix forward with a new migration + code, not a DB restore. |
| Migration itself corrupts/loses data, or a destructive migration (drop/alter with data loss) was applied | Yes (to match the pre-migration build) | **Yes** | Restore-from-backup is the only undo. Follow the version-skew rule above — roll the app back to the pre-migration build's alias *before* restoring, or restore only to a snapshot at that build's migration head. |
| `_nopm_migrations` ledger and actual schema disagree (a migration file was edited after being applied, or applied out of band) | No | Investigate manually | This is a process failure, not something either rollback path fixes — do not restore or roll back blind; diagnose the drift first (compare `_nopm_migrations` rows against `web/supabase/migrations/` filenames and the live `information_schema`). |
| Live data corruption from a bug (not a migration) — e.g. a write path wrote wrong values | Depends — roll back app if the bug is still deploying bad writes | Only if the corruption can't be fixed forward with a corrective write | Prefer a corrective, audited write (every mutation still gets an `audit_log` row) over a DB restore when the schema itself is fine — a restore loses every legitimate write since the snapshot too. |
| Supabase project paused/unreachable (not a code or schema issue) | No | No | Not a rollback scenario — see the free-tier pause incident (`sprint-log/2026-08-13_oss-finetune/SPRINT_SUMMARY.md`, "Incident — live demo outage"). Resume the project via the Supabase dashboard; no code or data was affected. |

## Waiver

If a failure doesn't cleanly match a row above, escalate — do not restore or roll back on a guess. Record the decision in [05-GO-NO-GO.md](05-GO-NO-GO.md)'s waiver section if the cutover proceeds despite the open failure.

---

**Signature**

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner (rollback decision) | | | |
| Client witness (optional) | | | |

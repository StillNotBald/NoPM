# 10 · Common-pattern answers rollout (migrations 0076–0081, 0083–0086)

**Status: READY, NOT YET RUN** — fill in the run record at the end when it is executed. Rehearse `--dry-run` first.

Release runbook for the build that carries owner decisions 19 to 25 and the common-pattern defaults (ADR 0015, requirements R-120 to R-126): overspend warning, project-deletion refusal, token life, required two-step with a grace period, budget change control, deferred-request reopen, tier-B decisions and documents, people management, rebaseline cards, workspace time zone, delivery retry. It extends [02-DEPLOY.md](02-DEPLOY.md).

**Order, fixed:** backup → dry run → apply `--atomic` → verify the ledger → deploy the build → smoke. **Apply the migrations BEFORE the new build serves traffic.** The new build reads columns and calls functions that exist only after the migrations.

## Migration files in this release (10)

These are exactly the files present in `web/supabase/migrations/` after 0075 (0076-0081 and 0083-0086). **There is no `20261017000082_*` file**; the number is intentionally unused (0082 was never written) and the runner applies by filename, so the gap is harmless.

| File | What it does |
|---|---|
| `20261017000076_governance_flow_answers.sql` | `deletion_requests.closed_reason`; `nopm_lock_project` returns `already_locked` for a locked project; `nopm_commit_project_deletion` refuses (P0022) while approved change requests or approved/applied rebaselines exist and returns the stored file paths; new `nopm_transition_change_request` (review, reopen) and `nopm_withdraw_rebaseline` |
| `20261017000077_cancel_orphan_draft_rebaselines.sql` | one-off: every rebaseline still in `draft` becomes `cancelled`, one audit row each (`orphan_draft_cleanup`); the lifecycle trigger is disabled and re-enabled inside the file |
| `20261017000078_budget_overspend_level.sql` | `project_budget` remembers the last overspend level so one audit row is written per threshold crossing |
| `20261017000079_decision_supersede_loop_guard.sql` | trigger backstop: a decision's supersede chain cannot loop |
| `20261017000080_work_record_rules.sql` | `risks.resolution`; `tasks.content_updated_at` (backfilled from `updated_at` with the stamp trigger switched off, so no task's own `updated_at` moves); partial unique index for one live clash per person and type (skipped with a notice if the data already has duplicates) |
| `20261017000081_mfa_grace.sql` | `profiles.mfa_grace_started_at` (backfilled for current admins and managers) and a trigger that keeps it right |
| `20261017000083_people_roles_removal.sql` | `profiles.status`, `removed_at`, `removed_by`, `removed_prev_role`; `nopm_member_change` (role, remove, restore in one transaction, last admin protected) and `nopm_member_mfa_reset` |
| `20261017000084_workspace_time_zone_rebaseline_cards.sql` | `workspaces.time_zone` (default Malaysia); widens the chat `approval_kind` checks for rebaseline sign-off (NOT VALID then VALIDATE); `nopm_demo_rate_refund` |
| `20261017000086_sprint_close_budget_cr_consumption.sql` | new `nopm_close_sprint` (sprint close, task move and audit row in one transaction); `change_requests.budget_consumed_at` / `budget_consumed_by` so one approved change request authorises one budget change |
| `20261017000085_risk_issue_taxonomy.sql` | `risk_category` and `issue_category` move to 8 values each (existing rows remapped to the closest new value; guarded no-op on fresh installs); `rebaseline_signoffs` legacy sign-off columns renamed to `proxy_for` and `cast_by` |

All are additive or widening and idempotent. The release is intended to be backward compatible (the build that is live today should keep working between the migration commit and the promote); the dry run is where you confirm it.

## 1. Before you start

- [ ] Clean tree on the commit you will deploy. `ls web/supabase/migrations | tail -10` shows the ten files above after `20261017000075_*`.
- [ ] The live direct connection string (port 5432) is in `web/.env.local` or exported as `DB_URL`. Never print it.
- [ ] No new environment variables in this release. Confirm the existing ones are unchanged (`NOPM_ENCRYPTION_KEY`, `CRON_SECRET`, `NEXT_PUBLIC_APP_URL`, `SUPABASE_SERVICE_ROLE_KEY`).
- [ ] Tell the team: admins and managers will see a two-step reminder; they have 14 days from the release.

## 2. Backup

```bash
cd web
supabase db dump --db-url "$DB_URL" -f ../backup-pre-0076-<yyyymmdd-hhmm>.sql    # private; never commit it
```

Restore rules are in [03-ROLLBACK.md](03-ROLLBACK.md) and [04-BACKUP-RESTORE.md](04-BACKUP-RESTORE.md). Read-only checks to note (none blocks the run):

```sql
-- the ledger holds 0001-0075 (expect 75 rows, none of the ten names above)
select count(*) from _nopm_migrations;
-- rebaselines that 0077 will cancel
select count(*) as draft_rebaselines_to_cancel from rebaselines where status = 'draft';
-- duplicate live clashes (0080 skips its unique index with a notice if > 0)
select count(*) from (select workspace_id, resource_member_id, type from clashes
  where resource_member_id is not null and status in ('open','investigating')
  group by 1,2,3 having count(*) > 1) d;
```

Neither number blocks the run.

## 3. The window

1. **Build, do not alias:** `cd web && vercel deploy --prod --skip-domain`. Note `<NEW_URL>`; `curl <NEW_URL>/api/health` answers ok. It is on the old schema; do not exercise governed screens yet.
2. **Dry run:** `node scripts/migrate.mjs --atomic --dry-run`. Expect 10 files applied, then `ROLLED BACK. Nothing changed.` Read every notice. File the output ([06-DRY-RUN-RECORDS.md](06-DRY-RUN-RECORDS.md)).
3. **Apply:** `node scripts/migrate.mjs --atomic`. Expect `Committed 10 file(s) in one transaction` and `PostgREST schema cache reload requested`. On `FAILED` nothing was applied; fix the cause and re-run.
4. **Verify the ledger (read-only):**
   ```sql
   select count(*) from _nopm_migrations;                                                   -- 85
   select proname from pg_proc where proname in ('nopm_transition_change_request','nopm_withdraw_rebaseline',
     'nopm_member_change','nopm_member_mfa_reset','nopm_demo_rate_refund','nopm_close_sprint');   -- 6 rows
   select column_name from information_schema.columns where table_name = 'profiles'
     and column_name in ('mfa_grace_started_at','status');                                   -- 2 rows
   select column_name from information_schema.columns where table_name = 'workspaces' and column_name = 'time_zone'; -- 1 row
   select count(*) from rebaselines where status = 'draft';                                   -- 0
   ```
   Also confirm the new functions are granted to `service_role` only. Any miss: do not promote.
5. **Deploy (promote):** `vercel promote <NEW_URL>`; `vercel ls` confirms the production alias moved.

**The two-step grace starts at release**: 0081 stamps `mfa_grace_started_at` on current admins and managers when it is applied, so their 14 days run from the apply, not from the promote. Keep the gap between apply and promote short.

## 4. After the promote (smoke)

1. `curl https://stillnotbald.com/api/health`, then `cd web && node scripts/auth-smoke.mjs`.
2. Throwaway project, governed smoke (creates real audit rows):
   - `GET /api/projects/{id}/budget` includes `overspend`.
   - `GET /api/workspace-settings` returns `time_zone` `Asia/Kuala_Lumpur`.
   - Raise a change request, `POST .../review` (manager), `POST .../decision` with `expected_updated_at`.
   - `GET /api/auth/mfa` as an admin shows `in_grace: true` and `grace_days_left` of 14 or 13.
   - `GET /api/members` as an admin lists people.
   - `POST /api/tokens` without `expires_at` returns an expiry about 90 days ahead.
3. Check `/review` and the console People page load.

## 5. Owner step (not code)

In the Supabase dashboard set the session length to **14 days** (Auth, Sessions; needs the Pro plan). This answers Q-ACC-20 and is not changeable from the codebase. Until it is set, sessions keep the provider default.

## Rollback

Migrations are forward-only ([03-ROLLBACK.md](03-ROLLBACK.md)). Every one in this release is additive or widening, so the safe default is **leave the schema, roll the app back**: `vercel rollback`. Do not drop the new columns: the old build ignores them. The cancelled draft rebaselines (0077) are recoverable from the audit rows and the backup; they were unusable anyway.

## Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner (rollout executed, smoke filed) | | | |

## Run record

_Not yet run._ Record here: backup taken, dry-run output, apply output and time, ledger check, promote time, smoke result, and the date the Supabase session length was set.

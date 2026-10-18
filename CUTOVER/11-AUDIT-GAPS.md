# 11 · Audit-gap programme rollout (migrations 0088–0099)

**Status: SKELETON, NOT YET RUN.** This file covers waves 1 to 3 of the audit-gap programme (change request CR-2026-10-18-01): migrations 0088–0094 in waves 1 and 2, and 0095–0099 in wave 3. Wave 4 adds its migrations and rows here when it lands, and this runbook grows with them.

It follows [10-COMMON-PATTERN-ANSWERS.md](10-COMMON-PATTERN-ANSWERS.md). Apply that release first. The runner applies by filename, so 0088–0094 land after 0086 in the same window.

**Order, fixed:** backup → dry run → apply `--atomic` → verify the ledger → deploy the build → smoke. **Apply the migrations BEFORE the new build serves traffic.**

## Known consequences

- **Historical self-approval frozen by 0089.** A change request whose stored requester principal equals its decider (a self-approval recorded before the check existed) is left alone by 0089. The NOT VALID check now fires on any update to that row, so it can no longer be edited at all, including "Mark implemented". The 0089 NOTICE prints the count of such rows. The owner decides whether to leave them frozen; the code does not change them.
- **The new build needs 0092 to 0094 first.** Creating a change request, creating a decision, creating a document, and the Change Control and Decisions pages all read or write columns those three files add. Serving the new build before they are applied breaks those paths, so apply them before promote.

## Migration files in this release (7)

| File | What it does | Gap |
|---|---|---|
| `20261018000088_lock_integrity.sql` | Records who locked a project as an actor (`locked_by_actor_type`, `locked_by_actor_id`, `locked_by_label`), so a token or connector lock is named. | M7, K3 |
| `20261018000089_four_eyes_backfill_validate.sql` | Backfills the requester principal on old change and deletion requests, then validates the principal-distinct checks that 0045 left NOT VALID. | G6 caveats |
| `20261018000090_risk_category_deprecate.sql` | Comment only: marks `risks.category` as deprecated. The column stays. | K1 |
| `20261018000091_risk_impact_areas.sql` | Adds `risks.impact_areas` (array), backfilled from the single area, with a sync trigger. | K2 |
| `20261018000092_change_request_implemented.sql` | Adds the implemented stamp columns and `impact_scope`, and the check that implementation is not before the decision. | M2, B2 |
| `20261018000093_decision_change_request_link.sql` | Adds `decisions.change_request_id` (set null on delete) and `decisions.options_structured`. | B1 |
| `20261018000094_document_evidence.sql` | Adds the evidence columns to documents: `change_request_id`, `evidence_type`, `evidence_result`, `tested_by_label`, `tested_at`. | M4 |

No file here drops a table or a column. Each header lists a manual rollback, but the rule from release 10 stands: leave the schema and roll the app back.

## Wave 3 additions (migrations 0095–0099)

Wave 3 adds five files. If it ships in the same window as 0088–0094, the dry run expects 12 files applied, and the ledger count after the apply is 97 (92 plus five).

| File | What it does | Gap |
|---|---|---|
| `20261018000095_backup_owner.sql` | Adds nullable `backup_owner_id` (profiles) to projects, risks and issues, and `backup_assignee_id` (resource members) to tasks, with partial indexes and a CHECK that a backup differs from its owner or assignee. No backfill. | M6 |
| `20261018000096_workspace_nudge_settings.sql` | Adds `stale_days`, `nudges_enabled`, `weekly_report_enabled` and `weekly_report_day` to workspaces. Adds the `nudge_log` ledger (one row per item per recipient per day) and `weekly_reports`, the stored weekly report. | A3, A4 |
| `20261018000097_budget_etc.sql` | Adds `estimate_to_complete` and `forecast_method` to the budget. Adds `assigned_approver_id` to change requests, deletion requests and rebaselines. | B3, G5 |
| `20261018000098_project_snapshots.sql` | Creates `project_snapshots`, one row per project per day. Members can read it; only the service role writes it. | B6 |
| `20261018000099_project_dependencies.sql` | Creates `project_dependencies`, with cross-workspace and loop guards. Redefines the project-deletion guard (see below). | B5 |

**The project-deletion guard now counts one more table.** Migration 0099 redefines `nopm_project_child_counts`, so the child counts and the content fingerprint include `project_dependencies` (on either side). `project_snapshots` is deliberately excluded. It is derived data regenerated every night, and counting it would refuse every pending project deletion after the next snapshot run. Pending project deletion requests are re-snapshotted at the end of 0099, so the new counts do not refuse them.

**Apply 0095 to 0099 in ONE `--atomic` run.** Migration 0095 changes the project row (`backup_owner_id`). The re-snapshot at the end of 0099 records the project fingerprint of pending deletions. If 0095 and 0099 land in separate runs, a pending deletion is re-snapshotted against a row that a later run changes again, and it would be refused at approval. Run the five files together, and check the ledger count of 97 before promote.

### Hard dependencies for wave 3

- **0095 before the handover, backup and list routes.** `views.ts` selects the backup columns on every list and detail read. The project header badge is the only fail-soft reader.
- **0096 before the nudge settings save.** Without it the app keeps working: settings read as defaults, the nudge and report steps log and skip, and the Kanban stale flag stays at 14 days. Saving the new settings fails.
- **0097 before the Budget page, the budget, EVM and snapshot code, and the approvals routes.**
- **0098 before the first nightly snapshot.** The cron writes `project_snapshots`, and the trend route reads it. The first trend appears the morning after the first run.
- **0099 before the dependency routes and the portfolio contingency rollup.**

### Scope and schedule changes in wave 3

- **New scope `report:read`.** It opens `GET /api/reports/weekly`. It is not privileged, and the `report:*` wildcard covers it. A token that reads the weekly report needs the scope added by name.
- **Second Vercel cron.** `web/vercel.json` runs `/api/cron/snapshots` at `37 17 * * *` (17:37 UTC, 01:37 in Asia/Kuala_Lumpur). It sits beside `/api/integrations/cron` at `7 1 * * *`. Both authenticate with `CRON_SECRET`, which must be set in the production environment before the first run.

### Wave 3 checks and smoke

Verify the ledger and the new columns after the apply:

```sql
select count(*) from _nopm_migrations;                                                    -- 97 when waves 1 to 3 are all in
select column_name from information_schema.columns where table_name in ('projects','risks','issues')
  and column_name = 'backup_owner_id';                                                    -- 3 rows
select column_name from information_schema.columns where table_name = 'tasks'
  and column_name = 'backup_assignee_id';                                                 -- 1 row
select column_name from information_schema.columns where table_name = 'project_budget'
  and column_name in ('estimate_to_complete','forecast_method');                          -- 2 rows
select to_regclass('project_snapshots'), to_regclass('project_dependencies');             -- both not null
```

Smoke after promote:

1. Open a project at 390 px and check the header badge and the Backup owner picker. Open Handover. `GET /api/reports/handover?format=json` returns 200 for a token that holds the four read scopes.
2. `GET /api/cron/snapshots` with `Authorization: Bearer <CRON_SECRET>` returns 200. It writes snapshot rows and one `snapshot.taken` audit row per workspace. A second call the same day writes no new snapshot rows. Without the secret it returns 401.
3. Open the Budget page. The Forecast and trend card and the Suggested RAG line render at 390 px.
4. Open Portfolio and check the Contingent tag. Open What changed, and check that Approvals shows All and Mine.

## Hard dependencies

- **0091 before the risk routes.** The risk list, create and export routes read and write `impact_areas`. The old build ignores the column.
- **0092 and 0093 before the change-control and decisions lists.** The change-request list, the implement route and the decision link read `implemented_*`, `impact_scope`, `change_request_id` and `options_structured`.
- **0094 before the evidence panel and the audit pack.** The evidence route and the change-request export read the evidence columns.
- **0088 before the lock routes.** The lock route writes the `locked_by_actor_*` columns.
- **0089 validates checks that were NOT VALID.** A legacy row that breaks one of them stops the apply. The dry run shows it, and nothing is fixed silently.

## Window

1. **Build, do not alias:** `cd web && vercel deploy --prod --skip-domain`. Note `<NEW_URL>`.
2. **Backup:** the same dump as release 10, saved as `backup-pre-0088-<yyyymmdd-hhmm>.sql`. It is private and never committed.
3. **Dry run:** `node scripts/migrate.mjs --atomic --dry-run`. Expect 7 files applied, then `ROLLED BACK. Nothing changed.` Read every notice and file the output in [06-DRY-RUN-RECORDS.md](06-DRY-RUN-RECORDS.md).
4. **Apply:** `node scripts/migrate.mjs --atomic`. Expect `Committed 7 file(s) in one transaction`. On `FAILED` nothing was applied; fix the cause and re-run.
5. **Verify (read-only):**
   ```sql
   select count(*) from _nopm_migrations;                                                    -- 92 if release 10 is in and nothing else is
   select column_name from information_schema.columns where table_name = 'projects'
     and column_name in ('locked_by_actor_type','locked_by_actor_id','locked_by_label');      -- 3 rows
   select column_name from information_schema.columns where table_name = 'risks'
     and column_name = 'impact_areas';                                                       -- 1 row
   select column_name from information_schema.columns where table_name = 'change_requests'
     and column_name in ('implemented_at','impact_scope');                                   -- 2 rows
   select column_name from information_schema.columns where table_name = 'decisions'
     and column_name in ('change_request_id','options_structured');                          -- 2 rows
   select column_name from information_schema.columns where table_name = 'documents'
     and column_name in ('change_request_id','evidence_type','evidence_result','tested_by_label','tested_at'); -- 5 rows
   select conname, convalidated from pg_constraint
     where conname in ('cr_principal_distinct','deletion_principal_distinct','ts_principal_distinct');        -- 3 rows, all true
   ```
   The expected count of 92 is derived from the ledger after release 10 (85) plus these seven files. The dry run confirms it. Any miss: do not promote.
6. **Deploy (promote):** `vercel promote <NEW_URL>`; `vercel ls` confirms the production alias moved.

## Smoke (after promote)

1. `curl https://stillnotbald.com/api/health`, then `cd web && node scripts/auth-smoke.mjs`.
2. `GET /api/change-requests?view=full` returns 200 and carries `implemented_at` (null is fine).
3. `GET /api/decisions` returns 200. `GET /api/projects/{id}/evm` returns the `cpi` and `spi` keys.
4. Throwaway project, governed smoke (creates real audit rows): raise a change request, approve it as a second person with `expected_updated_at`, `POST .../implement` once (200), then again (422 `already_implemented`).
5. Attach a document with `change_request_id` and `evidence_type`, then `GET /api/change-requests/{id}/evidence` lists it.
6. As an admin session, `GET /api/export?entity=audit_pack&from=<today>&to=<today>` returns CSV whose first column is `section`.
7. At 390 px, open the Change control, Decisions and Trust pages and check the new evidence panel and audit pack button.

## Owner step (not code)

None in this release. The owner acceptance test is the UAT plan under `sprint-log/2026-10-18_audit-gaps/`.

## Rollback

Forward-only, as in [03-ROLLBACK.md](03-ROLLBACK.md). Use `vercel rollback`, and leave the new columns in place. The old build ignores them.

## Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner (rollout executed, smoke filed) | | | |

## Run record

_Not yet run._ Record here: backup taken, dry-run output, apply output and time, ledger check, promote time and smoke result. Waves 3 and 4 add their own run records below this line.

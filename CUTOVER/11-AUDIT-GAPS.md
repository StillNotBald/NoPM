# 11 · Audit-gap programme rollout (migrations 0088–0094)

**Status: SKELETON, NOT YET RUN.** This file covers waves 1 and 2 of the audit-gap programme (change request CR-2026-10-18-01). Waves 3 and 4 add their migrations (from 0095) and their rows here, and this runbook grows with them.

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

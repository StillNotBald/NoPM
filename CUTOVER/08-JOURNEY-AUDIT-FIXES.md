# 08 · Journey-audit fixes rollout (migrations 0059–0067, 0069, 0071)

**Status: READY, NOT YET RUN** — fill in the run record at the end when it is executed. Rehearse `--dry-run` first.

Release runbook for the build that follows the journey map and the 2026-10-17 audit: approver roles (decision 16, ADR 0014), own-hours-only time entries (decision 17), idempotency keys, MFA step-up, audit `principal_id`, atomic governance RPCs, rebaseline controls in the console, project-deletion child audit, and the MCP, CLI, OpenAPI and `llms.txt` updates. It extends [02-DEPLOY.md](02-DEPLOY.md) and copies the order of [07-LARK-WAVE-ROLLOUT.md](07-LARK-WAVE-ROLLOUT.md).

**Order, fixed:** backup → pre-check → environment → build without aliasing → dry-run → apply `--atomic` → post-check → promote (deploy) → smoke. **Apply the migrations BEFORE the new build serves traffic.** The new build calls functions and tables that only exist after the migrations (see "New build against the old schema" below) and fails closed on them.

Unlike the Lark wave, this release is **backward-compatible**: every migration is additive and the older RPCs are kept, so the build that is live today keeps working between the migration commit and the promote (one exception, noted under 0061). There is no multi-minute window to protect.

## Migration files in this release (11)

| File | What it adds |
|---|---|
| 0059 `auth_hardening` | `nopm_rate_peek` (read-only rate check for the pre-auth throttle) and `nopm_auth_user_for_invite` (retry-safe invite accept) |
| 0060 `mfa_replay_guard` | `user_mfa.last_totp_step` (a TOTP code works once) |
| 0061 `approver_role_backstop` | trigger on `deletion_requests`: a non-admin, non-manager decider is refused (P0018) |
| 0062 `rebaseline_apply_unlock_atomic` | `nopm_apply_rebaseline`, `nopm_unlock_project_audited` (audit row inside the transaction) |
| 0063 `signoff_decision_lock_atomic` | `nopm_signoff_rebaseline`, `nopm_decide_change_request`, `nopm_lock_project` |
| 0064 `governed_children_audit_and_refs` | `<type>.cascade_delete` audit rows on project deletion; `nopm_ref_counters` + `nopm_next_ref()` so CR-/DEC-/DOC- numbers are never reused |
| 0065 `documents_bucket_limit` | Storage bucket `documents` capped at 25 MiB |
| 0066 `project_rollup_keeps_updated_at` | the task roll-up no longer bumps `projects.updated_at` (no false 412) |
| 0067 `idempotency_keys` | server-only table for `Idempotency-Key` replays |
| 0069 `connector_revoke_atomic` | `nopm_revoke_connector` (one transaction) |
| 0071 `audit_principal` | nullable `audit_log.principal_id` |

Numbers 0068 and 0070 do not exist; the runner applies by filename, so the gap is harmless. The live ledger should hold 0001–0058 (58 rows) before the run.

## 1. Before you start

- [ ] Tell the team: no approvals for ten minutes around the apply (they would still work; this only keeps the smoke clean).
- [ ] You are on the commit you will deploy, clean tree. `ls web/supabase/migrations | tail -12` shows the eleven files above.
- [ ] The live direct connection string (port 5432) is in `web/.env.local` or exported as `DB_URL`. Never print it.
- [ ] No new environment variables in this release. Verify these are still present and unchanged: `NOPM_ENCRYPTION_KEY`, `CRON_SECRET`, `NEXT_PUBLIC_APP_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NOPM_DEMO_LLM_*`. Optional: `NOPM_RATE_READ_PER_MIN`, `NOPM_RATE_WRITE_PER_MIN`.

## 2. Backup and pre-check

```bash
cd web
supabase db dump --db-url "$DB_URL" -f ../backup-pre-0059-<yyyymmdd-hhmm>.sql    # private; never commit it
```

Restore rules are in [03-ROLLBACK.md](03-ROLLBACK.md) and [04-BACKUP-RESTORE.md](04-BACKUP-RESTORE.md). Then run these read-only checks as `postgres` in the SQL editor and paste the result into the cutover ticket:

```sql
-- A. the ledger is where this runbook assumes (expect 58, and none of the eleven names present)
select count(*) from _nopm_migrations;
-- B. nothing from this wave exists yet (expect 0 rows)
select proname from pg_proc where proname in (
  'nopm_rate_peek','nopm_auth_user_for_invite','nopm_apply_rebaseline','nopm_unlock_project_audited',
  'nopm_signoff_rebaseline','nopm_decide_change_request','nopm_lock_project','nopm_next_ref','nopm_revoke_connector');
select to_regclass('public.idempotency_keys'), to_regclass('public.nopm_ref_counters');
-- C. data the new rules will meet (note them, none blocks the run)
select count(*) as pending_deletion_requests_to_settle
  from deletion_requests where status = 'pending';
select count(*) as tokens_created_by_non_approvers_holding_approve_scopes
  from api_tokens t join profiles p on p.id = t.created_by
 where not t.revoked and p.role not in ('admin','manager')
   and t.scopes && array['task:delete:approve','project:delete:approve','time:approve','change:decide','rebaseline:approve'];
select count(*) as duplicate_ref_numbers from (
  select workspace_id, reference_id from change_requests group by 1,2 having count(*) > 1) d;
```

Gates: B returns no rows and both regclass values are null; the duplicate-reference count is 0 (0064 seeds its counter from the highest number in each table; if change requests hold duplicate reference numbers the unique-index step is skipped with a notice, so settle them first; the same check applies to decisions and documents). Tokens in the second query of C will stop approving once the new build serves (decision 16); tell their owners.

## 3. The window

1. **Build, do not alias:** `cd web && vercel deploy --prod --skip-domain`. Note `<NEW_URL>`; `curl <NEW_URL>/api/health` answers ok. Do not exercise governed screens on it yet, it is on the old schema.
2. **Dry run:** `node scripts/migrate.mjs --atomic --dry-run`. Expect 11 files applied, then `ROLLED BACK. Nothing changed.` Read every notice. File the output as a dry-run record ([06-DRY-RUN-RECORDS.md](06-DRY-RUN-RECORDS.md)).
3. **Apply:** `node scripts/migrate.mjs --atomic`. Expect `Committed 11 file(s) in one transaction` and `PostgREST schema cache reload requested`. On `FAILED` nothing was applied; fix the cause and re-run.
4. **Post-check (read-only):**
   ```sql
   select proname from pg_proc where proname in (
     'nopm_rate_peek','nopm_auth_user_for_invite','nopm_apply_rebaseline','nopm_unlock_project_audited',
     'nopm_signoff_rebaseline','nopm_decide_change_request','nopm_lock_project','nopm_next_ref','nopm_revoke_connector'); -- 9 rows
   select to_regclass('public.idempotency_keys'), to_regclass('public.nopm_ref_counters');                              -- both set
   select column_name from information_schema.columns where table_name = 'audit_log' and column_name = 'principal_id';  -- 1 row
   select column_name from information_schema.columns where table_name = 'user_mfa' and column_name = 'last_totp_step'; -- 1 row
   select tgname from pg_trigger where tgname = 'trg_deletion_approver_role';                                                -- 1 row
   select file_size_limit from storage.buckets where id = 'documents';                                                    -- 26214400
   ```
   Also confirm the privilege posture of 0054 still holds: the new tables and functions are not writable or executable by `anon` or `authenticated` (`idempotency_keys` and `nopm_ref_counters` have RLS on and no policy; every new function is granted to `service_role` only). Any miss: do not promote.
5. **Promote:** `vercel promote <NEW_URL>`; `vercel ls` confirms the production alias moved.

## 4. After the promote (smoke)

1. `curl https://stillnotbald.com/api/health`, then `cd web && node scripts/auth-smoke.mjs`.
2. Governed smoke (creates real audit rows; use a throwaway task and project):
   - A **member** calls approve on a pending deletion request: `403` "Only managers and admins can approve".
   - A **manager other than the requester** approves it: `200`, and the audit trail shows the entity delete, `deletion_request.approved` and, for a project, the `*.cascade_delete` child rows.
   - A **member** logs hours for another member: `403` "You can only log your own hours".
   - Retry `POST /api/time-entries` twice with the same `Idempotency-Key`: one entry.
   - Turn two-step off without a code: `422`.
   - On `/baselines`, lock a project, propose a rebaseline, sign off as a second manager, apply; the project baseline moves and the audit rows exist. Unlock shows the cancellation warning when a rebaseline is open.
   - `GET /api/audit?limit=1` returns `principal_id`.
3. Tell the owners of approve-scoped tokens created by non-managers (query C above) that those tokens no longer approve.

## 5. Rollback notes

Migrations are forward-only ([03-ROLLBACK.md](03-ROLLBACK.md)). Every one in this release is additive, and the older RPCs stay, so the safe default is **leave the schema, roll the app back**: `vercel rollback` (then `vercel promote` the fixed build later; see [02-DEPLOY.md](02-DEPLOY.md) on the pinned alias).

| File | If you must undo |
|---|---|
| 0059, 0060 | Leave. New functions and a nullable column; the previous build ignores them. |
| 0061 | The only change the previous build can feel: a deletion decided by a member or viewer principal now fails with P0018 (the previous build would have allowed it). To restore the old behaviour drop the trigger: `drop trigger trg_deletion_approver_role on deletion_requests; drop function nopm_deletion_approver_role();`. This weakens decision 16; re-create when the new build returns. |
| 0062, 0063 | Leave. New functions; the 0028/0055/0058 functions the previous build calls are untouched. |
| 0064 | Leave. It redefines `nopm_commit_project_deletion` (same signature, extra audit rows) and adds a counter table plus a unique index. Do not drop the counter once numbers were issued: a number could be reused. |
| 0065 | `update storage.buckets set file_size_limit = null where id = 'documents'` removes the cap; the app still checks the declared size. |
| 0066 | Leave. The roll-up trigger function only skips bumping `updated_at` for a `completion_pct` change. |
| 0067 | `drop table idempotency_keys;` (nothing references it); the new build then fails the four keyed creates, so only do it with the app rolled back. |
| 0069 | Leave. A new function. |
| 0071 | Leave. A nullable column with no constraint. Dropping it loses the principal on rows already written. |

Database restore (dump or PITR) is the last resort and loses every write since the dump; never restore to a point earlier than the head of a build that is still serving.

## New build against the old schema (why the order matters)

Missing objects make these fail until the apply: rebaseline sign-off and apply, project lock and unlock, change-request decisions (the new routes call the new RPCs), every idempotent create (no `idempotency_keys`), every audit write that sets `principal_id` (unknown column), the MFA code check (`last_totp_step`), the per-IP bearer throttle (`nopm_rate_peek`), invite accept retries, connector revoke, and reference-number allocation. Do not deploy before the post-check passes.

## Previous build against the new schema

Everything keeps working, with these differences: a deletion decided by a member or viewer is refused by the 0061 trigger (surfaces as a 500 in the old routes); audit rows written by the old build carry no `principal_id` (it stays NULL); the old lock and unlock paths still work through the earlier functions.

## Do not

- Apply a migration by hand without writing its ledger row, or run two runners at once.
- Deploy the build before the post-check passes.
- Treat a green dry run as the apply: it rolls back.

---

**Signature**

| Role | Name | Date | Signature |
|---|---|---|---|
| Owner (rollout executed, post-check filed) | | | |
| Client witness (optional) | | | |

## Run record

_Not yet run._ Record here: backup taken, pre-check output, dry-run output, apply output and time, post-check, promote time, smoke result.

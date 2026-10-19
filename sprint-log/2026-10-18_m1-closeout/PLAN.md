# Wave 5 plan: M1 close-out and agent evidence (2026-10-18), revision 2

Closes everything the v2 audit report (`_docs/directions-2026-10-17/NOPM_AUDIT_REPORT_v2.md`) still rates PARTIAL or MISSING, except Slack/Teams and OAuth (need the maintainer), Q2 and UAT-018 (owner has not answered). Base: branch `fix/uat-cycle-2-2026-10-18` at 241b577 (cycle 2 committed). Change request: [CHANGE-REQUEST.md](CHANGE-REQUEST.md) (CR-2026-10-18-02). UAT: [UAT-PLAN.md](UAT-PLAN.md). Revision 2 applies `review/plan-review.md` (PR-01 to PR-29; the PR ids are cited below).

## Ground rules (every builder, reviewer, tester)

Same as `sprint-log/2026-10-18_audit-gaps/cycle2/BRIEF.md`, restated where they bit before:

- Work only in `stillnotbald/NoPM-build`. Never run `git stash/checkout/reset/clean/commit/push`. The lead commits. Never run migrations against any database except the local Docker one named in the brief; migrations are files, verified by read-only SQL text tests plus the lead's local rehearsal.
- Live is off limits: no probe, request or script may point at stillnotbald.com or the live database. The live checks are a SQL file the owner runs (wave 3).
- Edit only files in your ownership list. Anything else goes in your RTM note and you stop at the boundary. **Lead-owned files** (builders never edit them, they list the change they need in their RTM note): `web/src/lib/audit/atomicity.test.ts`, `atomicity-group2.test.ts`, `workspace-isolation.test.ts` (`web/src/lib/auth/`), `web/src/lib/audit/coverage.test.ts`, `web/src/lib/audit/action-glossary.ts`, `web/src/components/audit/chain-badge.tsx`, `web/src/lib/auth/mfa-factor.ts`, `web/src/lib/audit/sql-audit-insert.ts`, `web/src/types/pg-shim.d.ts`, `web/src/app/api/openapi.json/route.ts`, `web/src/app/llms.txt/route.ts`, `requirements/REQUIREMENTS.md`, `requirements/TRACEABILITY.md`. Exception: wave 3 W5-H edits OpenAPI and llms.txt.
- RTM notes: `rtm/<id>.md` (bullet plus table row, shape of `rtm/w4d.md`, plain paths, no brace globs) and `rtm/<id>-openapi-notes.md`. Wave 3 applies the notes.
- Every mutation keeps exactly one audit row, same action name and same `before`/`after` shape as today (auditors' tooling must not change). New write paths follow the mechanism table below. Every dedicated RPC writes its audit row through the shared helper `nopm_audit_insert` (Pre-0), never its own copy of the insert.
- Behaviour that changes who may do what is enforced in the database and the route, never UI-only.
- Migrations: additive, idempotent (`if not exists`, `create or replace`), must not fail on live data, rollback comment at the top, constraints added `not valid` then validated inside an exception block that RAISES (not NOTICE) on failure (audit G6).
- No model-family names in prose or comments (write "builder agent"). No real people or organisations. Run `node scripts/commit-gate.mjs` from the repo root before reporting.
- **Memory rules (the machine ran out of memory):** at most 3 builders at once; every vitest run uses `--maxWorkers=2` and only your own files; never the full suite (the lead runs it, one process at a time, at the end of a sub-wave); no browser, Playwright or dev server during the build phase; only the lead starts or stops the local Supabase stack; verifiers run one at a time.
- Gates before reporting, from `web/`: `npx tsc --noEmit -p .` (0 errors), `npx vitest run --maxWorkers=2 <your files>` (green), `npx eslint <your files>` (0 errors).
- Report: owner-visible changes (or "None"), files, migration and its behaviour on existing rows, gate counts, what could not be verified, RTM note paths, and the lead-owned test edits you need.
- Review: one adversarial review and one fix pass per sub-wave (rule: cap review rounds). High-risk builders also get one verifier that tries to break the change against the local database.

## Numbering

- Migrations (changed from revision 1, because of the helper and the post-deploy trigger): **0107** shared audit helper (lead), **0108** W5-A, **0109** W5-B, **0110** W5-C, **0111** W5-D, **0112** W5-E, **0113** W5-G pre-deploy, **0114** W5-G post-deploy trigger. A builder needing a second number asks the lead.
- R-IDs: next free R-161 (cycle 2 used R-155 to R-160). Ranges below are unchanged. UAT IDs are minted only by the lead in `UAT-log/01-FINDINGS.md`.

## Lead pre-steps, in order

- **Pre-0 (before wave 1a): shared SQL audit-insert helper.** Migration `20261018000107_audit_insert_helper.sql` defines `nopm_audit_insert(p_workspace_id uuid, p_audit jsonb, p_target_id uuid, p_before jsonb, p_after jsonb)`: the 17-column `audit_log` insert of `0103:215-231` (action, actor, channel, request id, principal, connector provenance), service role only, with the same `INVALID_CHANNEL` check. Also `web/src/lib/audit/sql-audit-insert.ts` (`buildRpcAudit(actor, action, targetType, overrides)`, a thin wrapper over the existing `buildAuditArg`, so RPC callers pass the same `p_audit` shape as `audited-write.ts`, including the system actor from `systemActor()`), with `sql-audit-insert-migration.test.ts` pinning column parity with 0103 (PR-11). Every builder's RPC calls `nopm_audit_insert`.
- **Pre-1 (before wave 1a): split the exceptions.** The 24 entries are confirmed (15 routes + 9 libraries, `atomicity.test.ts:28-52`). The lead moves them into three data files `web/src/lib/audit/atomicity-exceptions-governance.ts`, `...-security.ts`, `...-jobs.ts` (same entries), edits `atomicity.test.ts` to merge the three, and moves the two connector lines of `atomicity-group2.test.ts:22-27` into the security file (the group2 list then holds none; PR-04). Builders delete only the lines of their own file as they convert. The lead alone edits `atomicity.test.ts`, `atomicity-group2.test.ts`, `workspace-isolation.test.ts` and `coverage.test.ts` and does so after each sub-wave from the builders' RTM notes (PR-02).
- **Pre-3 (before wave 2b): `pg` type shim.** `web/src/types/pg-shim.d.ts` with a minimal `declare module "pg"` (Client, connection options, query). There is no `@types/pg` and `tsconfig` is strict, so a typed import needs the shim; adding `@types/pg` is a new dependency and needs the maintainer (PR-15).
- **Pre-2 (after wave 2a and 2b builders report, before their review): glossary names.** The lead adds the new audit actions to `action-glossary.ts` in one edit: `audit.anchored`, `audit.anchor_failed`, `audit.anchor_mismatch`, `program.delete_requested`, `sprint.delete_requested`, `resource.delete_requested`, `allocation.delete_requested`, `clash.delete_requested`, and the five matching `*.delete` commit names the builders report. Until then `action-glossary.test.ts` is a known red for W5-E and W5-G; they list the action names they write in their report (PR-25).

## Mechanism per straggler (all 24)

Mechanisms: **RPC** = dedicated function, audit row written by `nopm_audit_insert` in the same transaction. **WRAP** = existing `nopm_mutate_audited` through `audited-write.ts`. The 8/12/4 grouping still holds as a count. Only two of the 24 can use the wrapper; the plan of revision 1 assumed far more (PR-05 to PR-09).

| # | Straggler | Builder | Mechanism | Why |
|---|---|---|---|---|
| 1 | `projects/[id]#DELETE` | A | RPC `nopm_request_deletion` | deletion_requests insert plus audit plus approval event; table not allowlisted |
| 2 | `tasks/[id]#DELETE` | A | RPC `nopm_request_deletion` | same |
| 3 | `projects/[id]/change-requests#POST` | A | RPC `nopm_raise_change_request` | tier, reference id, deadline event; 23505 mapping |
| 4 | `projects/[id]/rebaselines#POST` | A | RPC `nopm_propose_rebaseline` | `uniq_pending_rebaseline` detail string must survive |
| 5 | `change-requests/[id]#PATCH` | A | RPC `nopm_edit_change_request` | not allowlisted |
| 6 | `change-requests/[id]#DELETE` | A | RPC `nopm_withdraw_change_request` | not allowlisted |
| 7 | `lib/governance/request-deletion.ts` | A | RPC `nopm_request_deletion` | the five maker steps |
| 8 | `lib/governance/decide.ts` | A | RPCs `nopm_withdraw_deletion_request`, `nopm_reopen_deletion_request` | approve path untouched |
| 9 to 12 | `auth/mfa/{challenge,disable,enroll,verify}#POST` | B | RPC per transition (`nopm_mfa_*`) | `user_mfa` has no workspace column; state change plus audit only (counters stay outside, PR-08) |
| 13 | `integrations/connectors#POST` | B | RPC `nopm_connector_write` | audit payload is the masked public view (group2 note) |
| 14 | `integrations/connectors/[id]#PATCH` | B | RPC `nopm_connector_write` | same, plus which secrets changed |
| 15 | `integrations/github/connector#POST` | B | RPC `nopm_github_connector_write` | masked view; secret column omitted from audit |
| 16 | `integrations/github/connector#PATCH` | B | RPC `nopm_github_connector_write` | writes `integration_connectors` AND `workspaces.work_event_rules`, two audit rows, one transaction (`route.ts:169-175`) |
| 17 | `integrations/github/connector#DELETE` | B | RPC `nopm_github_connector_write` | revoke |
| 18 | `lib/assistant/token.ts` | B | **WRAP** on `api_tokens` | mint (insert) and revoke (update `revoked`); `omitColumns: ["token_hash"]` |
| 19 | `lib/governance/invite-accept.ts` | B | RPC `nopm_revoke_other_invites` | bulk revoke by email, one audit row per invite (`:213-259`) |
| 20 | `lib/integrations/identity.ts` | B | RPC `nopm_link_identity` | consume link code, revoke previous, insert, tenant pin, audit, in one transaction (`:178-345`) |
| 21 | `lib/clash/detect.ts` | C | **WRAP** for create and update-existing, small RPC `nopm_clash_auto_resolve` for resolve | actor is the CALLER of the allocation write, not a system actor; resolve needs the live-status guard so a race writes no second audit row |
| 22 | `lib/insight/overspend.ts` | C | RPC `nopm_overspend_cross` | compare-and-set on a non-null previous level, audit payload is not the row |
| 23 | `lib/insight/snapshots.ts` | C | RPC `nopm_snapshot_run`, system actor | batch upsert plus one audit row per run |
| 24 | `lib/nudges/weekly-report.ts` | C | RPC `nopm_weekly_report_store`, system actor | claim, store, audit |

## Test ownership (each test file belongs to exactly one builder; PR-03)

If a file below turns red because of another builder's change, that builder reports it to the lead instead of editing.

| Owner | Test files |
|---|---|
| Lead | `atomicity.test.ts`, `atomicity-group2.test.ts`, `auth/workspace-isolation.test.ts`, `audit/coverage.test.ts`, `sql-audit-insert-migration.test.ts`, `action-glossary.test.ts`, the openapi, llms and tools-openapi coverage tests (until W5-H) |
| W5-A | `app/api/four-eyes-principal.test.ts`, `lifecycle-guards.test.ts`, `lifecycle-guards-2.test.ts`, `approval-tiers-edge.test.ts`, `deletion-by-request-all.test.ts`, `projects/[id]/change-requests/route.test.ts`, `lib/review/assignee.test.ts`, `components/governance/request-deletion.test.ts`, `lib/governance/deletion-dispatch.test.ts`, `lock-db-backstop.test.ts`, `lib/auth/guard-principal.test.ts`, `lib/integrations/inbound.test.ts`, `inbound-rebaseline.test.ts`, `catchup.test.ts` (only if they break), new `lib/governance/atomic-governance-migration.test.ts` and `app/api/change-requests/atomic-governance-routes.test.ts` |
| W5-B | `app/api/auth/mfa/mfa-routes.test.ts`, `mfa-recovery.test.ts`, `app/api/integrations/connectors/route.test.ts`, `[id]/route.test.ts`, `[id]/actions.test.ts`, `[id]/deliveries/deliveries.test.ts`, `components/integrations/contract.test.ts`, `app/api/integrations/github/github-routes.test.ts`, `integrations/identities/identities.test.ts`, `lib/integrations/lark/handlers.test.ts`, `app/api/invites/accept/route.test.ts`, `route.restore.test.ts`, `lib/governance/invite-accept.test.ts`, `invite-sweep.test.ts`, new `lib/auth/atomic-security-migration.test.ts` |
| W5-C | `lib/clash/detect.test.ts`, `lib/nudges/weekly-report.test.ts`, `app/api/reports/weekly/route.test.ts`, `app/api/cron/snapshots/route.test.ts`, `app/api/projects/[id]/budget/route.test.ts`, `route.forecast.test.ts`, `app/api/allocations/allocations-route.test.ts`, `app/api/cross-tenant-refs.test.ts`, `app/api/backup-owner.test.ts`, new `lib/insight/atomic-jobs-migration.test.ts` |
| W5-D | `app/api/tasks/_schema.test.ts`, `_query.test.ts`, `app/api/atomic-audit-routes.test.ts`, `app/api/work-rules.test.ts`, export and members tests, views tests |

## Wave 1a: atomic write path A and B, plus the two small fields (3 builders)

Start after Pre-0 and Pre-1. A, B and D share no file once the lead-owned files are excluded.

### W5-A governance atomicity (high risk) | migration `20261018000108_atomic_governance.sql` | R-161, R-162

Owns: the migration; `web/src/app/api/projects/[id]/route.ts` (DELETE only); `web/src/app/api/tasks/[id]/route.ts` (DELETE only); `web/src/app/api/projects/[id]/change-requests/route.ts` (POST); `web/src/app/api/projects/[id]/rebaselines/route.ts` (POST); `web/src/app/api/change-requests/[id]/route.ts` (PATCH, DELETE); `web/src/lib/governance/request-deletion.ts`; `web/src/lib/governance/decide.ts`; `web/src/lib/audit/atomicity-exceptions-governance.ts`; a thin RPC wrapper `web/src/lib/governance/atomic-rpc.ts`; the tests listed for W5-A; `web/scripts/local-db/probe-atomic-governance.mjs`.

- **R-161** Change requests and rebaselines write and audit in one transaction (audit M1; table rows 3 to 6). Acceptance: (a) RPCs `nopm_raise_change_request`, `nopm_edit_change_request`, `nopm_withdraw_change_request`, `nopm_propose_rebaseline`, service role only, workspace id a parameter and filtered in every statement, audit through `nopm_audit_insert`; (b) the emergency path `nopm_raise_emergency_change_request` is unchanged; the non-emergency raise still calls `classify()` before the RPC; (c) routes keep status codes, error codes and bodies byte for byte; audit actions `change_request.create`, `.update`, `.withdraw`, `rebaseline.create` keep their `before`/`after`; the 23505 mapping (`uniq_pending_rebaseline` detail text, version conflict) is preserved and tested; the `deadline_set` approval event moves into the RPC (same transaction); (d) a forced audit failure leaves no orphan row (local probe); (e) the four lines leave the exceptions file.
- **R-162** Deletion requests (maker step) and their withdraw or reopen write and audit in one transaction (rows 1, 2, 7, 8). Acceptance: (a) RPC `nopm_request_deletion(entity, target id, reason, assigned approver, tier, deadline, audit payload)` inserts the `deletion_requests` row, its `<entity>.delete_requested` audit row and the `deadline_set` event together; the project and task maker steps live in their route files and call the same RPC; (b) the entity-to-table map is a table `nopm_deletion_entities (entity, table_name, commit_rpc, child_count_sql)` created and seeded in 0108 for the seven current entities, so wave 2 adds entities with an `insert ... on conflict` and never rewrites the function (PR-12); (c) `nopm_withdraw_deletion_request` and `nopm_reopen_deletion_request` replace the status update plus audit in `decide.ts`; the approve path is untouched; (d) all blocks stay (locked project, milestone child check, project child-count fingerprint, task edit binding, self-approval, tier, deadline, `uniq_pending_deletion` 23505); (e) bodies, status codes and audit shapes unchanged; (f) the four lines leave the exceptions file.

Tests: migration text test (RPC names, workspace filter in every statement, calls `nopm_audit_insert`, revoke from public/anon/authenticated, grant to service role); route tests with the RPC mocked asserting unchanged bodies; probe against the local database with a throwaway workspace (orphan-row check).

### W5-B security and integration atomicity (high risk) | migration `20261018000109_atomic_security.sql` | R-163, R-164

Owns: the migration; `web/src/app/api/auth/mfa/{challenge,disable,enroll,verify}/route.ts`; `web/src/app/api/integrations/connectors/route.ts` and `connectors/[id]/route.ts`; `web/src/app/api/integrations/github/connector/route.ts`; `web/src/lib/assistant/token.ts`; `web/src/lib/governance/invite-accept.ts`; `web/src/lib/integrations/identity.ts`; `web/src/lib/audit/atomicity-exceptions-security.ts`; the tests listed for W5-B; `web/scripts/local-db/probe-atomic-security.mjs`. It does NOT edit `lib/auth/mfa-factor.ts` (lead-owned); where a change there is needed (an RPC-based step burn) the builder writes the exact change in the RTM note and the lead applies it.

- **R-163** MFA state changes and their audit rows are one transaction (rows 9 to 12). Acceptance: (a) one RPC per transition (`nopm_mfa_enroll`, `nopm_mfa_challenge`, `nopm_mfa_verify`, `nopm_mfa_disable`) writes the `user_mfa` change and the audit row together; TOTP verification stays in the app, the RPC records the outcome; the workspace id is the actor's (`actor.workspaceId`) and the RPC checks the user belongs to it; (b) the secret and backup codes never appear in `before`/`after` or logs (test asserts it); (c) **the attempt counter (`nopm_rate_check` via `spendMfaAttempt`) and the TOTP step burn (`consumeTotp`) stay OUTSIDE the audit transaction and keep incrementing when an audit write fails**, so a failing audit can never grant a free guess; only the state change plus its audit row, and the failed-attempt audit row alone, are atomic; (d) disable keeps its fallback for a database without `last_totp_step`; (e) responses, codes and lockout behaviour unchanged; (f) the four lines leave the exceptions file.
- **R-164** Connector, GitHub connector, assistant token, invite and identity writes are atomic (rows 13 to 20). Acceptance: (a) connectors and GitHub connector verbs use dedicated RPCs that build the masked public view in SQL for the audit row; GitHub PATCH writes the connector row and `workspaces.work_event_rules` with both audit rows (`connector` update and `work_event_rules.update`) in one transaction; secrets are encrypted in the route, shown once, and never enter an audit payload (test); (b) `lib/assistant/token.ts` mint and revoke use the wrapper on `api_tokens` with `omitColumns: ["token_hash"]`; (c) `nopm_revoke_other_invites(workspace, email, keep invite, audit context)` keeps the `ilike` escape, `accepted_at is null` and `revoked = false` guards and writes one `invite.revoked` row per invite, all in one transaction; (d) `nopm_link_identity` does consume link code, revoke previous links, insert identity, tenant pin and audit in one transaction, returns the conflict result for 23505, and replaces the compensating code at `identity.ts:339` and `:504`; a consumed code with no identity cannot exist; (e) all eight entries leave the exceptions file; audit shapes and behaviour unchanged.

Tests: migration text test; per-route tests asserting no secret in the audit payload; probe for the MFA outcome transaction, the link-code consume plus insert, and the bulk invite revoke.

### W5-D small fields (low risk) | migration `20261018000111_task_blocker_eta.sql` | R-166, R-167

Owns: the migration; `web/src/app/api/tasks/_schema.ts`; `web/src/app/api/tasks/route.ts`; `web/src/app/api/projects/[id]/tasks/route.ts`; `web/src/lib/api/views.ts`; `web/src/components/forms/task-form.tsx`; `web/src/components/tracking/activity-table.tsx`; `web/src/app/(console)/projects/[id]/page.tsx` (task blocker display only); `web/src/app/api/export/route.ts`; `web/src/lib/people/members.ts`; the tests listed for W5-D.

There is no seam with W5-A: `tasks/[id]/route.ts` PATCH builds its patch from the parsed schema (`route.ts:138`), so the schema change alone reaches it. W5-D does not edit that file (PR-22).

- **R-166** Optional blocker reason and ETA on tasks (audit A2). Acceptance: (a) migration adds `tasks.blocker_reason text` (max 500 CHECK) and `tasks.eta date`, both nullable, no default, no backfill; (b) create and update schemas accept both as optional and nullable, `name` stays the only required field; (c) a reason without `blocked_by` and `blocked_by` without a reason are both allowed; (d) an `eta` before today is allowed; (e) both appear in `task-form.tsx` as two optional inputs under "Blocked by" and on the task detail in `activity-table.tsx` and the project page, stacked at 390 px with no horizontal scroll; (f) **the lean list view always carries `blocker_reason` and `eta` (null when unset)**, as does the full view (`views.ts` is a static column list, PR-23); (g) edits follow normal task rules (blocked on a locked project, audited as `task.update`); (h) OpenAPI notes written.
- **R-167** Last sign-in in the access-review export (audit M5). Acceptance: (a) the `members` entity of `GET /api/export` gains `last_sign_in_at` read from the auth users with the service role through one paged `listUsers` (page cap stated in code), exported only when the caller is an admin; a manager's export has no such column; (b) a member who never signed in has an empty cell; (c) the value never reaches `GET /api/members` or the UI; (d) the export audit row is unchanged; (e) tests cover admin, manager and a member with no sign-in.

Tests: schema tests; migration text test; export column test; the reviewer renders the form at 390 px.

## Wave 1b: unattended jobs (1 builder, starts after W5-B reports)

### W5-C system-job atomicity (high risk) | migration `20261018000110_atomic_jobs.sql` | R-165

Owns: the migration; `web/src/lib/clash/detect.ts`; `web/src/lib/insight/overspend.ts`; `web/src/lib/insight/snapshots.ts`; `web/src/lib/nudges/weekly-report.ts`; `web/src/lib/audit/atomicity-exceptions-jobs.ts`; the tests listed for W5-C; `web/scripts/local-db/probe-atomic-jobs.mjs`.

- **R-165** Unattended and trigger-driven writes audit in one transaction (rows 21 to 24; D14 default: convert all four). Acceptance: (a) `detect.ts` create and update-existing use the wrapper on `clashes` with the CALLER actor, keep the 23505 retry; auto-resolve uses `nopm_clash_auto_resolve` (status guard in SQL, a lost race writes no second audit row); (b) `overspend.ts` uses `nopm_overspend_cross`: compare-and-set on the previous level, set the new level and write the `budget.overspend` row with the same `{level}` / `{level, planned_amount, actual, burn_pct, warn_pct}` payload, one transaction; it stays best effort and never blocks the expense; (c) `snapshots.ts` calls `nopm_snapshot_run` (upsert with `on conflict do nothing`, returns the taken count, one `snapshot.taken` row per workspace per run with the system actor, not one per project); (d) `weekly-report.ts` calls `nopm_weekly_report_store`: build the snapshot first, then in one transaction claim the scheduled recipients (unique claim wins a race), store the report and write the audit row; a lost claim returns "already_sent" and writes nothing; a manual run makes no claim; the day-wide claim delete (`weekly-report.ts:200`) goes away; notifications are sent after the transaction as today; (e) cron routes, schedules, counts and notification behaviour unchanged; (f) the four lines leave the exceptions file.

Tests: migration text test; lost-race unit tests (no audit row); probe running the snapshot cron twice and the weekly report twice.

## Wave 2a: deletion by request (G) and MCP surface (F) (2 builders)

Start after wave 1 is reviewed, fixed and committed.

### W5-G deletion by request for the remaining registers (high risk) | migrations `20261018000113_deletion_by_request_registers.sql` (pre-deploy) and `20261018000114_deletion_refuse_triggers.sql` (post-deploy) | R-176, R-177

Owns: both migrations; `web/src/app/api/programs/[id]/route.ts`, `sprints/[id]/route.ts`, `resources/[id]/route.ts`, `allocations/[id]/route.ts`, `clashes/[id]/route.ts` (DELETE handlers); `web/src/lib/governance/request-deletion.ts`; `deletion-dispatch.ts`; `tiers.ts` (the five deletion kinds only); `web/src/lib/review/pending.ts` and `web/src/app/(console)/approvals/**`; `web/src/app/api/deletion-requests/**`; the register UIs `web/src/app/(console)/{sprints,resources,clashes}/**` and the program and allocation components they use ("Request deletion" button only); `web/scripts/seed.mjs`, `web/scripts/seed-sprints-timesheets.mjs` (skip with a clear message when a delete is refused with P0040); `web/scripts/local-db/probe-register-deletion.mjs`; tests. It does NOT touch `lib/integrations/types.ts` or any chat card code.

- **R-176** Deletion by request for programs, sprints, resources (table `resource_members`), allocations and clashes (audit G8). Acceptance:
  - (a) **0113 (applied BEFORE the deploy)** extends the `deletion_requests.target_type` and approval-kind CHECKs, inserts the five rows into `nopm_deletion_entities`, adds `nopm_commit_<entity>_deletion` for each (delete plus audit in one transaction), and redefines `nopm_commit_task_deletion` so that it sets `nopm.deletion_commit` (PR-01).
  - (b) The migration lists every function that can delete from the five tables and proves each sets the flag: `nopm_commit_task_deletion` (task delete cascades allocations through `allocations.task_id`), `nopm_commit_project_deletion` (cascades sprints, allocations, clashes; sets it since 0102), the new program, sprint, resource (cascades allocations) and allocation and clash commits. The builder lists every other cascade (member removal RPCs, workspace-level deletes) and tests each on the local database.
  - (c) **0114 (applied AFTER the deploy, a separate file, PR-19)** attaches `nopm_refuse_direct_delete` to the five tables. Between 0113 and 0114 both the old and the new build keep working.
  - (d) `DELETE /api/<entity>/:id` becomes `requestDeletion()`. **Contract change: today these five routes answer 204 with no body; they will answer 202 with `{ data: <deletion_requests row> }`, the same body the existing five requests return** (`request-deletion.ts:250`). Recorded as owner decision D19. Audited as `<entity>.delete_requested`.
  - (e) Tier is fixed by the builder default (program high risk, the other four normal), approver never the requester; not routable in Settings (D15). `announceRequested` is skipped for the five kinds (no chat card, `lib/integrations/types.ts` untouched).
  - (f) Resource requests keep the `has_timesheet_records` refusal (`resources/[id]/route.ts:90-104`) at request time AND re-check it in the commit. The request snapshot carries the child counts and the allocation ids; the commit's audit row records the cascaded allocation ids in `after` (PR-21).
  - (g) A program with projects, a resource with allocations and a sprint with started tasks show child counts and use the existing fingerprint at approve time, so a stale request fails 422.
  - (h) An auto-resolved clash is a status change and is unaffected.
  - (i) The five kinds appear in Approvals (Mine, Waiting) and `GET /api/deletion-requests`.
- **R-177** "Request deletion" buttons for the five registers (audit G8, UI). Acceptance: button with a reason field for roles that could delete before, replacing any direct delete control; after submit a "deletion requested" chip and, for the requester, "Withdraw request"; usable at 390 px; none for read-only roles.

Tests: migration text test (flag set in every cascading commit RPC, CHECK lists, trigger only in 0114); route tests (202, 422 stale, self-approval refused, timesheet refusal); probe `probe-register-deletion.mjs` that (1) approves a task with an allocation, a project with a sprint, allocation and clash, and a resource with allocations before 0114 and after 0114, all must pass, and (2) tries a raw DELETE on each of the five tables after 0114, which must fail with P0040; approvals page render test.

Friction note for the owner (D15): allocations are routine planning edits. If the owner finds the request flow heavy for allocations and clashes, those two can be left as audited direct deletes and listed as justified exceptions (one scope line in 0113/0114 and the UI task).

### W5-F MCP surface for evidence and decision prep (low risk) | no migration | R-171 to R-175

Owns: `web/mcp/tools.mjs`; `web/src/lib/assistant/tools.ts`; `web/mcp/README.md`; a new route `web/src/app/api/change-requests/[id]/evidence/route.ts` (POST, next to the existing GET) with schema and test; `web/src/app/api/projects/[id]/decisions/_schema.ts` only if the MCP field needs it; tests under `web/src/lib/assistant/` and `web/mcp/`.

Every tool maps to an existing route except the one new attach endpoint, which is thin over the existing documents write. Nothing calls the database.

- **R-171** Evidence through MCP (audit M4). (a) `POST /api/change-requests/:id/evidence` takes an existing `document_id` or a new document body plus `evidence_type`, `evidence_result`, `tested_by`, `tested_at`, links it through the same code path as `POST /api/documents` (scope `document:write`, workspace filtered, audited `document.create` or `document.update`); (b) MCP `attach_evidence` calls it; `create_document` gains the optional evidence fields and `change_request_id`; (c) `get_change_request` text says evidence comes from the evidence route; (d) tests assert method and path.
- **R-172** Implement and decision link (audit M2, B1). (a) `implement_change_request` calls `POST /api/change-requests/:id/implement` (existing implement scope, never `change:decide`; text states the DB check `implemented_at >= decided_at`); (b) `create_decision` gains optional `change_request_id`; (c) descriptions use the cycle-2 wording (no retro text, no admin-only text for approved documents, `create_change_request` states that an emergency commits at once and needs `change:decide`), which also closes cycle-2 finding C2-10.
- **R-173** Decision-prep reads (audit B7). (a) `list_rebaselines` maps to `GET /api/projects/:id/rebaselines`; `get_baseline_history` returns the applied rebaselines in order with old and new dates from the same route (if the route lacks the old values, report to the lead, no SQL here); (b) `list_documents` maps to `GET /api/documents` with lean `fields`/`view`; (c) `list_project_dependencies` maps to `GET /api/projects/:id/dependencies`; (d) all four lean by default, registered in `assistant/tools.ts` with the same least-privilege rule.
- **R-174** Blocker reason and ETA through MCP (audit A2). `create_task`, `update_task` accept `blocker_reason` and `eta`; `list_tasks` lean view returns them (always present, null when unset, as W5-D ships).
- **R-175** Deletion requests for the new registers through MCP (audit G8). `request_program_deletion`, `request_sprint_deletion`, `request_resource_deletion`, `request_allocation_deletion`, `request_clash_deletion` mirror the existing tools (body `reason`, optional `assigned_approver_id`; route `DELETE /api/<entity>/:id` answering **202 with the request row**); `withdraw_deletion_request` text lists the new kinds. The lead verifies each tool against W5-G's real route before the sub-wave review.

Tests: one per tool asserting method, path, body and scope; zod schema tests; path-safety test extended; lean-default test for the four reads.

## Wave 2b: external anchor (1 builder, after 2a reviewed and fixed)

### W5-E external anchor (high risk) | migration `20261018000112_audit_anchor_receipts.sql` | R-168, R-169, R-170

Needs Pre-3 (the `pg` type shim). Owns: the migration; new folder `web/src/lib/audit/anchor/` (`sink.ts`, `postgres-sink.ts`, `noop-sink.ts`, `anchor.ts`, `compare.ts`, tests); `web/src/app/api/audit/verify/route.ts` and its test; `web/src/lib/audit/chain-head.ts`; `web/src/lib/integrations/cron.ts` and `web/src/app/api/integrations/cron/route.ts` (one added step) and their tests; `web/src/app/(console)/trust/**`; new `web/src/components/trust/anchor-status.tsx` (the lead adds the one-line mount in `chain-badge.tsx`); `web/src/lib/export/audit-pack.ts` and its test (one cover line); new `web/anchor-db/001_audit_anchors.sql`; `web/scripts/local-db/probe-anchor.mjs`; `web/.env.example` (it exists); new `CUTOVER/13-AUDIT-ANCHOR.md`. There is no manual anchor route (PR-27) and no new container.

Design (owner Q8, "different DB"):

- Interface `AnchorSink { put(record): Promise<PutResult>; latest(workspaceIds): Promise<Map<workspaceId, AnchorRecord>> }`. Record = `(workspace_id, chain_seq, head_hash, row_count, anchored_at)`. `postgres-sink.ts` uses the already-approved `pg` package (typed by the Pre-3 shim, no new dependency) against `NOPM_ANCHOR_DB_URL`: one short-lived client, TLS required, 5 s connect and 5 s statement timeout. TLS may be switched off only for a loopback host AND `NOPM_ANCHOR_ALLOW_PLAINTEXT_LOOPBACK=1`, set by the probe only (PR-17). With the URL unset the sink is `noop` and the state is `not_anchored`.
- Second-database schema (`anchor-db/001_audit_anchors.sql`): table `audit_anchors`, append-only (BEFORE UPDATE, DELETE and TRUNCATE triggers raise), unique `(workspace_id, chain_seq)`, role `nopm_anchor` with INSERT and SELECT only (D12 default).
- Primary migration 0112 adds `audit_anchor_receipts (workspace_id, chain_seq, head_hash, anchored_at, status, error_text, streak_started_at)` for the UI and for streak tracking only, never used to decide a comparison. **RLS on, select for admin and manager of the workspace, no write grant** (PR-28).

Order of operations (fixes PR-13): **verify first, record the result, then anchor the head that includes the verify row.**

1. `GET /api/audit/verify`: throttle, run `nopm_audit_verify_chain`, read the pre-verify head (`head_hash` as today), compare the live chain with the latest anchor (state before).
2. Write `audit.verified`; its `after` gains an `anchor` object (`state`, `chain_seq`, `anchored_at`, `previous_chain_seq`) so the trail itself records the anchor state at every verify (PR-16).
3. If the chain verified ok and the state before is not `mismatch`, read the head again (it is now the `audit.verified` row, whose hash links to the verified head) and `put` it. The response `anchor.state` is then `anchored` at the fresh head. A failed `put` never blocks anything.
4. The daily cron step (existing 01:07 UTC tick): per workspace verify only the rows since the last anchor (`p_limit` = rows since the anchored `chain_seq` plus the link row, capped at the verify maximum), and anchor only when that check is ok. If it is not ok it does not anchor and records `mismatch` (one `audit.anchor_mismatch` row per streak). When the anchor is the first for the workspace, or follows a failure streak, write one `audit.anchored` row first, then read the head and anchor it. A quiet day with an unchanged head adds nothing.

Cron budget (PR-18): one connection per tick, one query for the latest anchors of all workspaces, a step budget of 8 s inside the 40 s deadline, and after the first connection failure the rest of the workspaces are marked failed without further attempts.

Spec:

- **R-168** Anchor the chain head outside the database. (a) per the order above; a head already anchored is skipped; (b) a successful anchor writes NO `audit_log` row except the first or recovery `audit.anchored`; (c) with `NOPM_ANCHOR_DB_URL` unset nothing is written and nothing throws; (d) never anchor while the state is `mismatch` or the verification failed; (e) a unique conflict on `(workspace_id, chain_seq)` reads the stored record and compares: a different hash is `mismatch`, not a failed insert (PR-14); (f) `pg` is imported only inside `postgres-sink.ts`.
- **R-169** Verify compares the live head with the latest anchor. (a) `GET /api/audit/verify` adds `anchor: { state, anchored_at, chain_seq, row_count }` where state is `not_anchored`, `anchored`, `behind` (anchored head older than the live head by N rows, informational), `mismatch` (the live row at the anchored `chain_seq` has a different hash, or the live head is below the anchored `chain_seq`) or `unreachable`; (b) `mismatch` writes `audit.anchor_mismatch` ONCE per streak, not per verify, and the verify result is returned as failed; (c) the verify never reports an all-clear while the state is `mismatch` or `unreachable` and never reports `anchored` unless the comparison ran; (d) the five-minute throttle and the bounded window are unchanged; (e) tests: anchor a built chain, then delete the newest rows, then flip a hash, then regrow the chain to the same `chain_seq` with a different hash; each is `mismatch`; (f) the audit pack cover gets one line "Anchor: not anchored / anchored <time> (n rows) / mismatch", with `not_anchored` when the variable is unset; the weekly report and PDF are deliberately unchanged.
- **R-170** Trust Center shows the anchor and handles failure loudly. (a) `anchor-status.tsx` shows "anchored <time> (n rows)", "anchored <time>, <N> rows behind", "not anchored" plus one line on how to turn it on (never green, never hidden), a red "anchor mismatch" or amber "anchor unreachable since <time>"; the same object is what API, UI and audit pack show for an unset variable; (b) failure mode per D8 default (fail-open for business writes, loud for claims): a failed `put` never blocks a write or the cron; it records `status=failed` and `streak_started_at`, writes ONE `audit.anchor_failed` row per streak; the next success clears the streak; (c) visible to admins and managers at 390 px without horizontal scroll; (d) `CUTOVER/13-AUDIT-ANCHOR.md`: setup (create the second database, run `001_audit_anchors.sql`, create the role, set the variable in the host, first anchor, read back with SQL), the rehearsal steps, rollback (unset the variable).

Local rehearsal (required in the builder's report): `probe-anchor.mjs` creates a second database `nopm_anchor` and the role `nopm_anchor` inside the existing local Postgres (loopback only, port 54322, no new container, nothing on 54329) and runs: anchor, verify `anchored`, mismatch on a throwaway workspace after deleting the newest rows inside a rolled-back transaction, `unreachable` by pointing the URL at a closed loopback port plus exactly one `audit.anchor_failed`, and recovery. The probe refuses any non-loopback URL.

## Wave 3: cleanup, documentation, live checks, rehearsal (3 builders, I first)

Start after wave 2 is merged. W5-I runs first; W5-H and W5-J then run in parallel (2 builders at once).

### W5-I cleanup (low risk) | no migration | R-178, R-179

Owns (all earlier waves are done, so no clash): the cycle-2 leftover list C2-11, re-derived with a text search first (`retro_overdue`, `retro_`, `emergency_retro_hours`, `retro_due_at` in `web/src`, `web/mcp`): `web/src/lib/governance/tiers.ts`, `web/src/lib/export/audit-pack.ts`, `web/src/components/integrations/approval-policy-card.tsx`, `web/src/lib/review/four-eyes.ts`, `web/src/app/api/change-requests/[id]/route.ts` (open-status list only), `web/src/lib/review/pending.test.ts`, `web/src/lib/governance/timers.test.ts`, `web/src/components/change-control/change-form.tsx`, `change-detail.tsx`, `web/src/app/(console)/approvals/page.tsx` (retro fields on the deletion type), `web/src/lib/governance/decide.ts` (retro fields on `ChangeRow`), `web/src/lib/integrations/cron.ts` (comments only), `web/src/lib/notify/publish.ts` (comment), `web/src/lib/api/views.ts` (document retro columns as history), `web/mcp/tools.mjs` line 61 status list only after the live check below; `web/scripts/seed-members.mjs`; tests.

- **R-178** Retire the emergency retro leftovers (audit G4). (a) no reader, type, validation message, help text or test of the retired retro model remains except the three history columns and the `retro_overdue` approval-event kind; (b) `emergency_retro_hours` is accepted and ignored with a documented deprecation (D17 builder default); (c) `emergency` leaves the decidable and open status lists (and `tools.mjs:61`) only after the live check in `CUTOVER/12` shows no row in that status; if unchecked, the builder leaves it and says so; (d) audit-pack CSV header keeps `is_emergency` as yes or blank and restores a blank `retro_overdue` for one more release (C2-13).
- **R-179** Seed logins on a neutral domain (audit S5). Seed members use `@example.com`; docs quoting the old addresses are updated; the commit gate stays green.

`schedule_threshold_days` (G1): left as built until the owner answers D18.

### W5-H documentation (low risk, after I reports) | none

Owns: `web/src/app/api/openapi.json/route.ts`; `web/src/app/llms.txt/route.ts`; `web/mcp/README.md` (tool table only); new `docs/adr/0018-external-audit-anchor.md` (also records the fixed deletion tiers, D15); `docs/use-cases/` updates; `sprint-log/2026-10-18_m1-closeout/OWNER-VISIBLE.md`; the `UAT-PLAN.md` fill; `CUTOVER/11-AUDIT-GAPS.md` extension.

- Applies every `rtm/*-openapi-notes.md` from waves 1 and 2, and the retro text fixes cycle 2 deferred: `openapi.json/route.ts` lines 106, 196-197, 315-316, 2729-2730, 2815, 3302, 3833-3834 (PR-24).
- Release order in `CUTOVER/11`: apply migrations 0107 to 0113 in order, deploy, apply 0114, set the anchor variable last and optionally.
- OWNER-VISIBLE flags: five DELETE routes 204 to 202 (D19), the Trust Center "not anchored" line, and the new members export column.

### W5-J post-release checks and rehearsal (low risk) | none | R-180

Owns: new `CUTOVER/12-POST-RELEASE-CHECKS.md`; new `web/scripts/local-db/rehearse-0107-0114.mjs` (loopback only); test `web/src/lib/governance/post-release-checks.test.ts`.

- **R-180** Read-only SQL checklist for the owner. Acceptance as in revision 1, with these updates: (a) plain SQL blocks, every statement `select` only (a test scans the file and fails on `insert`, `update`, `delete`, `alter`, `drop`, `create`, `truncate`, `grant`); (b) `pg_constraint.convalidated` for the four-eyes CHECKs (0089, 0106), the implemented-after-decided CHECKs (0092), the `deletion_requests` target type and approval-kind CHECKs (0102, 0113), `projects_lock_integrity` (0088); (c) lock rows: projects with `is_locked` and a null or nil-UUID `locked_by`, and the ERP-EMEA project by a name pattern the owner edits; (d) 0106 counts: change requests in status `emergency`, requests with a retro column set, workspaces whose `work_event_rules` still hold a completed rule, pending expense deletions below `high_risk` over the threshold; (e) migration ledger rows 0087 to 0114 present with no gaps (0114 only after it is applied); (f) audit chain: gapless `chain_seq` per workspace, rows with a null `row_hash`, the newest `audit.verified` row; (g) the receipts table: latest status per workspace (only after the anchor is set up); (h) the five registers have the delete-refusing trigger (only after 0114); (i) no probe, request or script targets live; the file says so at the top.
- The rehearsal script applies 0107 to 0113, runs the register probe, applies 0114, and applies the whole range a second time, printing row counts before and after, to prove idempotence and no data loss.

## Order, sizes and gates

| Sub-wave | Builders | Migrations | R-IDs | Review |
|---|---|---|---|---|
| Pre-0, Pre-1 (lead) | none | 0107 | none | lead runs its tests |
| 1a | W5-A, W5-B, W5-D (3) | 0108, 0109, 0111 | R-161 to R-164, R-166, R-167 | after 1b: one review, one fix; verifiers A, then B (one at a time) |
| 1b | W5-C (1), after W5-B reports | 0110 | R-165 | verifier C; then the lead applies the lead-owned test edits and runs the full suite once |
| Pre-3 (lead) | none | none | none | none |
| 2a | W5-G, W5-F (2) | 0113, 0114 | R-171 to R-177 | verifier G |
| 2b | W5-E (1) | 0112 | R-168 to R-170 | one review of 2a+2b, one fix; verifier E; lead runs Pre-2, then the full suite once |
| 3 | W5-I, then W5-H and W5-J (3 over two steps) | none | R-178 to R-180 | one review |

Known-red tests the lead should expect until fixed (not builder failures): after 1a and 1b the lead-owned `atomicity.test.ts` family and `workspace-isolation.test.ts` until the lead edits them; after 2a and 2b `action-glossary.test.ts` until Pre-2, and the OpenAPI, llms and tools-openapi coverage tests until W5-H (PR-25).

Release order: apply 0107 to 0113 (all additive, safe with the old build), deploy the build, apply 0114 (the delete-refusing triggers, PR-19), then optionally set the anchor (`CUTOVER/13`). Until the variable is set the Trust Center honestly says "not anchored". Tag the cycle as an annotated tag after the owner's PR yes (separate decision, per the standing merge rule).

## Not planned, with reason

| Item | Reason |
|---|---|
| Slack and Teams sync (A6) | needs the maintainer (new integrations) |
| OAuth (K4) | needs the maintainer (constitutional) |
| Q2 routine tier, UAT-018 | owner has not answered |
| Manual `POST /api/audit/anchor` | dropped: not an audited gap, cron plus verify already anchor (PR-27) |
| Chat approval card for the five new deletion kinds | dropped: integration change outside G8 (PR-27) |
| Settings tier routing for the five new kinds | fixed tiers, decision D15 |
| `@types/pg` | would be a new dependency; a local shim is used (Pre-3) |
| B4 per-task baseline history | medium effort and its own scope; owner to decide whether the project-level history in R-173 is enough |
| Task backup owner (M6 note) | not in the requested scope; small, can follow |
| MCP policy tool (G1) | not in the requested scope; read-only policy tool is a follow-up |
| MCP access-review export (M5) | not in the requested scope |

# Wave 5 plan: M1 close-out and agent evidence (2026-10-18)

Closes everything the v2 audit report (`_docs/directions-2026-10-17/NOPM_AUDIT_REPORT_v2.md`) still rates PARTIAL or MISSING, except Slack/Teams and OAuth (need the maintainer), Q2 and UAT-018 (owner has not answered). Base: branch `fix/uat-cycle-2-2026-10-18` with the cycle-2 tree committed first (the lead commits cycle 2 before wave 1 starts; nothing below assumes an uncommitted base). Change request: [CHANGE-REQUEST.md](CHANGE-REQUEST.md) (CR-2026-10-18-02). UAT: [UAT-PLAN.md](UAT-PLAN.md).

## Ground rules (every builder, reviewer, tester)

Same as `sprint-log/2026-10-18_audit-gaps/cycle2/BRIEF.md`, restated where they bit before:

- Work only in `stillnotbald/NoPM-build`. Never run `git stash/checkout/reset/clean/commit/push`. The lead commits. Never run migrations against any database except the local Docker one named in the brief; migrations are files, verified by read-only SQL text tests plus the lead's local rehearsal.
- Live is off limits: no probe, request or script may point at stillnotbald.com or the live database. The live checks are a SQL file the owner runs (wave 3).
- Edit only files in your ownership list. Anything else goes in your RTM note and you stop at the boundary.
- Nobody edits `web/src/app/api/openapi.json/route.ts`, `web/src/app/llms.txt/route.ts`, `requirements/REQUIREMENTS.md`, `requirements/TRACEABILITY.md`. Write `rtm/<id>.md` (bullet plus table row, shape of `rtm/w4d.md`, plain paths, no brace globs) and `rtm/<id>-openapi-notes.md`. Wave 3 applies them.
- Every mutation keeps exactly one audit row, same action name and same `before`/`after` shape as today (auditors' tooling must not change). New mutations go through `nopm_mutate_audited` (wrapper `web/src/lib/audit/audited-write.ts`) or a dedicated RPC that writes the audit row in the same transaction.
- Behaviour that changes who may do what is enforced in the database and the route, never UI-only.
- Migrations: additive, idempotent (`if not exists`, `create or replace`), must not fail on live data, rollback comment at the top, constraints added `not valid` then validated inside an exception block that RAISES (not NOTICE) on failure, so a silent NOT VALID cannot recur (audit G6).
- No model-family names in prose or comments (write "builder agent"). No real people or organisations. Run `node scripts/commit-gate.mjs` from the repo root before reporting.
- Gates before reporting, from `web/`: `npx tsc --noEmit -p .` (0 errors), `npx vitest run <your files>` (green), `npx eslint <your files>` (0 errors). Not the full suite; the lead runs it.
- Report: owner-visible changes (or "None"), files, migration and its behaviour on existing rows, gate counts, what could not be verified, RTM note paths.
- Review: one adversarial review and one fix pass per wave (rule: cap review rounds). High-risk builders also get one verifier that tries to break the change against the local database.

## Numbering

- Migrations: next free `20261018000107`. One number per builder, assigned below. A builder needing a second asks the lead.
- R-IDs: next free R-161 (cycle 2 used R-155 to R-160). Ranges below. UAT IDs are minted only by the lead in `UAT-log/01-FINDINGS.md`.

## Lead pre-steps (not builder work)

- **Pre-1 (before wave 1).** Split the `EXCEPTIONS` map in `web/src/lib/audit/atomicity.test.ts` into three data files `web/src/lib/audit/atomicity-exceptions-governance.ts`, `...-security.ts`, `...-jobs.ts` (same entries, merged by the test). Each builder deletes only the lines of its own file as it converts, so the three never share a file. Confirm the 24 entries first (15 routes + 9 libraries, as of `atomicity.test.ts:28-52`; cycle 2 may have changed it). `atomicity-group2.test.ts` is read to see whether it carries a second list.
- **Pre-2 (before wave 2).** Add the new audit actions to `web/src/lib/audit/action-glossary.ts` in one edit, so no builder shares the glossary: `audit.anchored`, `audit.anchor_failed`, `audit.anchor_mismatch`, `program.delete_requested`, `sprint.delete_requested`, `resource.delete_requested`, `allocation.delete_requested`, `clash.delete_requested`.

## Wave 1: atomic write path (M1a) and the two small fields (A2, M5)

Four builders, no shared file. The three atomic builders touch 24 stragglers: 8 + 12 + 4.

### W5-A governance atomicity (high risk) | migration `20261018000107_atomic_governance.sql` | R-161, R-162

Owns: the migration; `web/src/app/api/projects/[id]/route.ts` (DELETE only); `web/src/app/api/tasks/[id]/route.ts` (DELETE only); `web/src/app/api/projects/[id]/change-requests/route.ts` (POST); `web/src/app/api/projects/[id]/rebaselines/route.ts` (POST); `web/src/app/api/change-requests/[id]/route.ts` (PATCH, DELETE); `web/src/lib/governance/request-deletion.ts`; `web/src/lib/governance/decide.ts`; `web/src/lib/audit/atomicity-exceptions-governance.ts`; their tests; new tests `web/src/lib/governance/atomic-governance-migration.test.ts`, `web/src/app/api/change-requests/atomic-governance-routes.test.ts`.

Spec:

- **R-161** Change requests and rebaselines write and audit in one transaction (audit M1, 4 handlers). Acceptance: (a) migration adds RPCs `nopm_raise_change_request`, `nopm_edit_change_request`, `nopm_withdraw_change_request`, `nopm_propose_rebaseline`, each inserting or updating the row and its audit row in one transaction, service role only, workspace id a parameter and filtered in every statement; (b) the emergency path keeps `nopm_raise_emergency_change_request` unchanged (already atomic from cycle 2); the non-emergency raise uses the new RPC and still goes through `classify()` for the tier before the call; (c) the four routes call the RPC through a thin wrapper next to `audited-write.ts` pattern, keep their status codes, error codes and response bodies byte for byte, and the audit rows keep action names `change_request.create`, `change_request.update`, `change_request.withdraw`, `rebaseline.create` with the same `before`/`after`; (d) a failure inside either half leaves neither (test with a forced audit failure on the local-DB probe `web/scripts/local-db/probe-atomic-governance.mjs`: no orphan row, 500 or 4xx unchanged); (e) the three lines `change-requests/[id]#PATCH`, `#DELETE`, `projects/[id]/change-requests#POST`, `projects/[id]/rebaselines#POST` leave `atomicity-exceptions-governance.ts`.
- **R-162** Deletion requests (maker step) and their withdraw or reopen write and audit in one transaction (audit M1, 4 entries). Acceptance: (a) RPC `nopm_request_deletion(entity, target id, reason, assigned approver, tier, deadline, audit payload)` handles the project and task maker steps and the five entities in `request-deletion.ts`, inserting the `deletion_requests` row and its `<entity>.delete_requested` audit row together; the entity to table map lives inside the RPC as a small allowlist so wave 2 can add entities with a data insert; (b) RPC `nopm_withdraw_deletion_request` and `nopm_reopen_deletion_request` replace the status update plus audit in `decide.ts`; the approve path is untouched; (c) all existing blocks stay: locked project, milestone child check, project child-count fingerprint, task edit binding, self-approval, tier and deadline; (d) response bodies, status codes and audit shapes unchanged; (e) `projects/[id]#DELETE`, `tasks/[id]#DELETE`, `lib/governance/request-deletion.ts`, `lib/governance/decide.ts` leave the exceptions file.

Tests to add: migration text test (RPC names, workspace filter in every statement, revoke from public/anon/authenticated, grant to service role); route tests with the RPC mocked asserting unchanged bodies; probe script against local DB (rollback-safe, uses a throwaway workspace) for the orphan-row check; ratchet test shrinks by 8.

### W5-B security and integration atomicity (high risk) | migration `20261018000108_atomic_security.sql` | R-163, R-164

Owns: the migration; `web/src/app/api/auth/mfa/{challenge,disable,enroll,verify}/route.ts`; `web/src/app/api/integrations/connectors/route.ts` and `connectors/[id]/route.ts`; `web/src/app/api/integrations/github/connector/route.ts`; `web/src/lib/assistant/token.ts`; `web/src/lib/governance/invite-accept.ts`; `web/src/lib/integrations/identity.ts`; `web/src/lib/audit/atomicity-exceptions-security.ts`; their tests; new `web/src/lib/auth/atomic-security-migration.test.ts`, `web/scripts/local-db/probe-atomic-security.mjs`.

Spec:

- **R-163** MFA state changes and their audit rows are one transaction (audit M1, 4 routes; the ratchet lists these as "decision needed", resolved by D13). Acceptance: (a) `user_mfa` has no workspace column, so it is NOT added to the `nopm_mutate_audited` allowlist; instead one RPC per transition (`nopm_mfa_enroll`, `nopm_mfa_challenge`, `nopm_mfa_verify`, `nopm_mfa_disable`) writes the `user_mfa` change and the audit row together, taking the workspace id from the caller's profile; (b) the secret and backup codes never appear in `before`/`after` or logs (existing redaction kept; test asserts it); (c) TOTP failure counters and lockout still increment on a failed verify, and that increment plus its `mfa.verify_failed` audit row are one transaction too; (d) responses, codes and the lockout behaviour unchanged; (e) the four lines leave the exceptions file.
- **R-164** Connector, GitHub connector, assistant token, invite and identity writes are atomic (audit M1, 8 entries). Acceptance: (a) `integrations/connectors#POST`, `connectors/[id]#PATCH`, and the three `integrations/github/connector` verbs use the audited wrapper (`integration_connectors` is allowlisted); where a verb writes two tables (connector plus encrypted secret) it uses one RPC `nopm_connector_write`; the secret is shown once and never enters the audit payload (test); (b) `lib/assistant/token.ts` mint and revoke use the wrapper on `api_tokens`; (c) `lib/governance/invite-accept.ts` revoke-on-failure uses the wrapper on `invites`; (d) `lib/integrations/identity.ts` link-code consume, identity insert and revoke use the wrapper on `external_identities`, the code consume and identity insert in one RPC so a consumed code with no identity cannot exist; (e) all eight entries leave the exceptions file; behaviour and audit shapes unchanged.

Tests to add: migration text test; per-route tests asserting the audit payload carries no secret; probe against local DB for the MFA lockout transaction and the link-code consume-plus-insert.

### W5-C system-job atomicity (high risk) | migration `20261018000109_atomic_jobs.sql` | R-165

Owns: the migration; `web/src/lib/clash/detect.ts`; `web/src/lib/insight/overspend.ts`; `web/src/lib/insight/snapshots.ts`; `web/src/lib/nudges/weekly-report.ts`; `web/src/lib/audit/atomicity-exceptions-jobs.ts`; their tests; new `web/src/lib/insight/atomic-jobs-migration.test.ts`.

Spec:

- **R-165** Unattended jobs write and audit in one transaction (audit M1, 4 libraries; D14: convert, do not exempt). Acceptance: (a) `clash/detect.ts` auto-create and auto-resolve use the audited wrapper on `clashes` with a system actor; (b) `overspend.ts` sets the level marker through the wrapper on `project_budget` and the crossing audit row is the same call; (c) `snapshots.ts` writes the nightly `project_snapshots` rows and its one batch audit row through RPC `nopm_snapshot_run` (one transaction, upsert semantics preserved, still one audit row per run and not one per project); (d) `weekly-report.ts` stores the report, the nudge claim and the send audit row through RPC `nopm_weekly_report_store`; the once-per-week unique claim still wins a race and a lost race writes nothing and no audit row; (e) cron routes, schedules, counts and notification behaviour unchanged; (f) the four lines leave the exceptions file.

Tests to add: migration text test; unit tests for the lost-race path (no audit row); probe against local DB running the snapshot cron twice (second run idempotent).

### W5-D small fields (low risk) | migration `20261018000110_task_blocker_eta.sql` | R-166, R-167

Owns: the migration; `web/src/app/api/tasks/_schema.ts`; `web/src/app/api/tasks/[id]/route.ts` (PATCH and GET only, not DELETE, which W5-A owns, see seam); `web/src/app/api/tasks/route.ts`; `web/src/app/api/projects/[id]/tasks/route.ts`; `web/src/lib/api/views.ts`; the task create and edit form components under `web/src/components/` (find them: the form behind `New task` and the detail panel `web/src/components/tracking/detail-panel.tsx`); `web/src/app/api/export/route.ts`; `web/src/lib/people/members.ts`; tests.

Seam: `tasks/[id]/route.ts` is edited by both W5-A (DELETE handler) and W5-D (PATCH, GET). Fix: W5-D does not touch that file in wave 1; it puts the PATCH and GET changes in the shared schema and helper files and a new file `web/src/app/api/tasks/_blocker-eta.ts` that the route calls, and the lead adds the one-line import after W5-A reports. If that proves impossible W5-D reports instead of editing.

Spec:

- **R-166** Optional blocker reason and ETA on tasks (audit A2). Acceptance: (a) migration adds `tasks.blocker_reason text` (max 500, CHECK) and `tasks.eta date`, both nullable, no default, no backfill; (b) create and update schemas accept both as optional and nullable, `name` stays the only required field; (c) a blocker reason without a `blocked_by` is allowed, and `blocked_by` without a reason is allowed; (d) `eta` before today is allowed (a late ETA is information); (e) both appear in the task detail panel and the create/edit form as two optional inputs under "Blocked by", stacked at 390 px with no horizontal scroll; (f) the lean list view carries `blocker_reason` and `eta` only when set (field list in `views.ts`), the full view always; (g) edits follow the normal task rules (blocked on a locked project, audited as `task.update`); (h) OpenAPI notes written.
- **R-167** Last sign-in in the access-review export (audit M5). Acceptance: (a) the `members` entity of `GET /api/export` gains a `last_sign_in_at` column read from the auth user metadata with the service role, exported only when the caller is an admin; a manager's export has no such column; (b) a member who never signed in has an empty cell, not the account creation time; (c) the value never reaches `GET /api/members` or the UI (export only); (d) the export audit row is unchanged; (e) test covers admin, manager and a member with no sign-in.

Tests to add: schema tests; migration text test; export column test; a render check of the form at 390 px by the reviewer.

### Wave 1 seams and order

- Disjoint ownership as listed. `tasks/[id]/route.ts` is the only near-miss and is handled by the helper-file rule above.
- Each atomic builder writes new tests into new files and edits only its own exceptions data file.
- After the wave: reviewer pass, fix pass, lead runs full `npm test`, `tsc`, `lint`, commit gate, merges RTM rows, `npm run rtm:verify`. Also run the migrations 0107 to 0110 twice against the local database (idempotent) and the three probes.

## Wave 2: external anchor (M1b), MCP evidence surface (M4/M2/B7), deletion by request (G8)

Three builders. Start after wave 1 is merged and Pre-2 is done.

### W5-E external anchor (high risk) | migration `20261018000111_audit_anchor_receipts.sql` | R-168, R-169, R-170

Owns: the migration; new folder `web/src/lib/audit/anchor/` (`sink.ts` interface, `postgres-sink.ts`, `noop-sink.ts`, `anchor.ts` orchestration, `compare.ts`, tests); `web/src/app/api/audit/verify/route.ts`; new `web/src/app/api/audit/anchor/route.ts`; `web/src/lib/audit/chain-head.ts`; `web/src/lib/integrations/cron.ts` and `web/src/app/api/integrations/cron/route.ts` (one added step); `web/src/app/(console)/trust/**` and a new `web/src/components/trust/anchor-status.tsx`; new `web/anchor-db/001_audit_anchors.sql` (the schema for the SECOND database); new `docker-compose.anchor.yml` (second Postgres on port 54329) and `web/scripts/local-db/probe-anchor.mjs`; `web/.env.example` (if present); new `CUTOVER/13-AUDIT-ANCHOR.md`; tests.

Design (per owner Q8, "different DB"):

- Interface `AnchorSink { put(record): Promise<void>; latest(workspaceId): Promise<AnchorRecord | null> }`. Record = `(workspace_id, chain_seq, head_hash, row_count, anchored_at)`. Default implementation `postgres-sink.ts` uses the already-approved `pg` package against `NOPM_ANCHOR_DB_URL`, one short-lived client per call, TLS required, 5 s connect and 5 s statement timeout. With the variable unset the sink is `noop` and the state is `not_anchored`.
- Second-database schema: table `audit_anchors` (append-only: BEFORE UPDATE, DELETE and TRUNCATE triggers raise), unique `(workspace_id, chain_seq)`, one role `nopm_anchor` with INSERT and SELECT only (see D12: a role that can only write cannot be read back by verify). The file documents how to create the role and the separate login.
- Primary-database migration 0111 adds `audit_anchor_receipts (workspace_id, chain_seq, head_hash, anchored_at, status, error_text)`: a local convenience copy for the UI and failure streak tracking only. It is never used to decide a comparison.

Spec:

- **R-168** Anchor the chain head outside the database. Acceptance: (a) on the existing daily cron (`vercel.json:5`, decision D11) and on every `audit.verified` the current head `(chain_seq, row_hash)` and `row_count` are read once per workspace and written with `sink.put`; a head already anchored is skipped (no duplicate row, no extra audit row); (b) an anchor success writes NO `audit_log` row (it would move the head and chase itself, A10); (c) `POST /api/audit/anchor` (admin only, audited as `audit.anchored` only when it is the first anchor for a workspace or follows a failure) forces one anchor; (d) with `NOPM_ANCHOR_DB_URL` unset nothing is written and nothing throws; (e) the anchor is taken from the same read as the verification, so the anchored head is the head that was verified; (f) `pg` is used only inside `postgres-sink.ts`; no new dependency.
- **R-169** Verify compares the live head with the latest anchor. Acceptance: (a) `GET /api/audit/verify` adds `anchor: { state, anchored_at, chain_seq, row_count }` to its payload where state is `not_anchored` (env unset), `anchored` (live row at the anchored `chain_seq` has the anchored `row_hash` and live row count is at least the anchored count), `behind` (anchored head older than the live head by N rows, informational), `mismatch` (hash differs, or live head is below the anchored `chain_seq`, i.e. newest rows were deleted) or `unreachable` (the anchor database did not answer); (b) `mismatch` writes an `audit.anchor_mismatch` row and returns the verify result as failed; (c) the verify never reports an all-clear while the anchor state is `mismatch` or `unreachable`, and never reports `anchored` unless the comparison ran (fail closed on claims); (d) the existing five-minute verify throttle and the bounded window are unchanged; (e) tests build a chain, anchor it, then delete the newest rows and flip a hash in a fixture and assert `mismatch` both times.
- **R-170** Trust Center shows the anchor and handles failure loudly. Acceptance: (a) the verify badge area shows "anchored <time> (n rows)" for `anchored`, "anchored <time>, <N> rows behind" for `behind`, "not anchored" with one line on how to turn it on for `not_anchored` (never green, never hidden), and a red "anchor mismatch" or amber "anchor unreachable since <time>" otherwise; (b) failure mode per D8 (recommended default: fail-open for business writes, loud for claims): a failed `put` never blocks a write or the cron; it records `status=failed` in the receipts table and writes ONE `audit.anchor_failed` row per failure streak (not per retry); the next success clears the streak; (c) the banner is visible to admins and managers at 390 px without horizontal scroll; (d) `CUTOVER/13-AUDIT-ANCHOR.md` has the setup steps (create the second database, run `001_audit_anchors.sql`, create the role, set the variable in Vercel, first anchor, how to read it back with SQL), the rehearsal steps, and the rollback (unset the variable).

Local rehearsal (required in the builder's report): `docker compose -f docker-compose.anchor.yml up -d`, run the probe: anchor, verify `anchored`, delete newest local audit rows inside a rolled-back transaction or on a throwaway workspace and verify `mismatch`, stop the container and verify `unreachable` plus exactly one `audit.anchor_failed` row, restart and verify recovery. The probe refuses any URL that is not loopback.

### W5-F MCP surface for evidence and decision prep (low risk) | no migration | R-171, R-172, R-173, R-174, R-175

Owns: `web/mcp/tools.mjs`; `web/src/lib/assistant/tools.ts`; `web/mcp/README.md`; a new route `web/src/app/api/change-requests/[id]/evidence/route.ts` (POST added next to the existing GET) with its schema and test; `web/src/app/api/projects/[id]/decisions/_schema.ts` only if the MCP field needs a schema tweak; tests under `web/src/lib/assistant/`.

Every tool maps to an existing route. Nothing calls the database. The one new route is the attach endpoint, which is thin over the existing documents write.

Spec:

- **R-171** Evidence through MCP (audit M4). Acceptance: (a) new route `POST /api/change-requests/:id/evidence` takes either an existing `document_id` or a new document body plus `evidence_type`, `evidence_result`, `tested_by`, `tested_at`, links it to the change request through the same code path as `POST /api/documents` (scope `document:write`, workspace filtered, audited as `document.create` or `document.update`, refuses a decided-and-implemented change only if the existing evidence rules do); (b) MCP `attach_evidence` calls it; `create_document` gains the same optional evidence fields and `change_request_id`; (c) MCP `get_change_request` already returns evidence through the evidence route; the tool text says so; (d) tests assert the tool's HTTP method and path.
- **R-172** Implement and decision link through MCP (audit M2, B1). Acceptance: (a) `implement_change_request` calls `POST /api/change-requests/:id/implement` (requires the existing implement scope, never `change:decide`; the tool text states the DB check that `implemented_at >= decided_at`); (b) `create_decision` gains optional `change_request_id`; (c) tool descriptions use the cycle-2 wording (no retro text, no admin-only text for approved documents, `create_change_request` states that an emergency commits at once and needs `change:decide`).
- **R-173** Decision-prep reads (audit B7). Acceptance: (a) `list_rebaselines` (project id) maps to `GET /api/projects/:id/rebaselines`; `get_baseline_history` returns the applied rebaselines in order with old and new dates from the same route (no new route; if the route lacks the old values, report to the lead instead of adding SQL here); (b) `list_documents` maps to `GET /api/documents` with lean `fields`/`view`; (c) `list_project_dependencies` maps to `GET /api/projects/:id/dependencies`; (d) all four are lean by default (summary view) and registered in `assistant/tools.ts` with the same least-privilege rule as the other reads.
- **R-174** Blocker reason and ETA through MCP (audit A2). Acceptance: `create_task`, `update_task` accept `blocker_reason` and `eta`; `list_tasks` lean view includes them when set (field names as shipped by W5-D).
- **R-175** Deletion requests for the new registers through MCP (audit G8). Acceptance: `request_program_deletion`, `request_sprint_deletion`, `request_resource_deletion`, `request_allocation_deletion`, `request_clash_deletion` mirror the existing `request_*_deletion` tools (body `reason`, optional `assigned_approver_id`; route `DELETE /api/<entity>/:id` answering 202); `withdraw_deletion_request` text lists the new kinds. Seam with W5-G: the route contract is frozen here (same as the five existing ones); the lead verifies each tool against the real route after W5-G reports and before the wave review.

Tests to add: one test per tool asserting method, path, body and scope; the zod schema tests; the path-safety test extended; lean-default test for the four reads.

### W5-G deletion by request for the remaining registers (high risk) | migration `20261018000112_deletion_by_request_registers.sql` | R-176, R-177

Owns: the migration; `web/src/app/api/programs/[id]/route.ts`, `sprints/[id]/route.ts`, `resources/[id]/route.ts`, `allocations/[id]/route.ts`, `clashes/[id]/route.ts` (DELETE handlers); `web/src/lib/governance/request-deletion.ts`; `web/src/lib/governance/deletion-dispatch.ts`; `web/src/lib/governance/tiers.ts` (deletion tier for the five kinds only); `web/src/lib/review/pending.ts` and the approvals page `web/src/app/(console)/approvals/**` (new kinds); `web/src/app/api/deletion-requests/**`; `web/src/lib/integrations/types.ts` (`deletionKindFor`); the register UIs `web/src/app/(console)/{sprints,resources,clashes}/**` and the program and allocation components they use (add the "Request deletion" button only); tests.

Spec:

- **R-176** Deletion by request for programs, sprints, resources, allocations and clashes in the database and API (audit G8). Acceptance: (a) migration extends the `deletion_requests.target_type` CHECK and the approval-kind CHECKs with the five types, adds `nopm_commit_<entity>_deletion` for each (delete plus audit in one transaction, sets `nopm.deletion_commit`), and attaches `nopm_refuse_direct_delete` to the five tables (raises P0040 on any other DELETE); (b) the migration first checks that no code path or foreign-key cascade still hard-deletes these tables outside a commit RPC (project and program commits set the flag so cascades pass; the builder lists each cascade and tests it on the local database); (c) `DELETE /api/<entity>/:id` becomes `requestDeletion()` and answers 202 `{ data: { request_id, status: "pending" } }`, audited as `<entity>.delete_requested`; (d) tier per D15 (recommended: programs high risk; sprints, resources, allocations, clashes normal); approver is never the requester; (e) a program with projects, a resource with open allocations and a sprint with started tasks show the child count in the request and need the existing child-count fingerprint at approve time, so approving a stale request fails 422; (f) an auto-resolved clash is a status change and is unaffected; (g) the five kinds appear in Approvals (Mine, Waiting), the chat hub card and `GET /api/deletion-requests`.
- **R-177** "Request deletion" buttons for the five registers (audit G8, UI). Acceptance: (a) each register page and detail has a "Request deletion" button for roles that could delete before, with a reason field, replacing any direct delete control; (b) after submit the row shows a "deletion requested" chip and the button is replaced by "Withdraw request" for the requester; (c) stacked and usable at 390 px; (d) no button for read-only roles.

Tests to add: migration text test (trigger attached to five tables, commit RPCs, CHECK lists); route tests (202, 422 on a stale fingerprint, self-approval refused); a local-database probe `web/scripts/local-db/probe-register-deletion.mjs` that tries a raw DELETE on each table (must fail P0040) and a cascade from a project commit (must pass); approvals page render test.

Friction note for the owner (D15): allocations are routine planning edits. The plan builds the request flow for all five as asked. If the owner finds it heavy for allocations and clashes, those two can be left as audited direct deletes and listed as justified exceptions; that is a one-line change in the migration scope and the UI task.

### Wave 2 seams

- `tools.mjs` and `assistant/tools.ts`: W5-F only. `request-deletion.ts`: W5-G only (W5-A converted it in wave 1). `trust/**`, `verify/route.ts`, `cron.ts`: W5-E only. `tiers.ts`: W5-G only this wave. `action-glossary.ts`: nobody (Pre-2). The evidence route file: W5-F only.
- After the wave: reviewer pass, fix pass, full gates, lead runs migrations 0111, 0112 twice on the local database, the anchor probe and the register probe, merges RTM rows.

## Wave 3: cleanup, documentation, live checks, rehearsal

Three builders. Start after wave 2 is merged.

### W5-I cleanup (low risk) | no migration | R-178, R-179

Owns: the files the cycle-2 reviewer listed as retro leftovers (re-derive the list with a text search first: `retro_overdue`, `retro_`, `emergency_retro_hours`, `retro_due_at` in `web/src`, `web/mcp`; the history columns and the already-written `retro_overdue` approval-event kind stay): `web/src/lib/governance/tiers.ts`, `web/src/lib/export/audit-pack.ts`, `web/src/components/integrations/approval-policy-card.tsx`, `web/src/lib/review/four-eyes.ts`, `web/src/app/api/change-requests/[id]/route.ts` (open-status list only), `web/src/lib/review/pending.test.ts`, `web/src/lib/governance/timers.test.ts`; `web/scripts/seed-members.mjs`; tests. Does not touch `tools.mjs` (W5-F already reworded it).

- **R-178** Retire the emergency retro leftovers (audit G4). Acceptance: (a) no reader, type, validation message, help text or test of the retired retro model remains except the three history columns and the `retro_overdue` event kind; (b) `emergency_retro_hours` is accepted and ignored with a documented deprecation (D17: keep, because stored data exists); (c) `emergency` is removed from the decidable and open status lists only after the live check in `CUTOVER/12` shows no row in that status (the checklist query is the gate; if unchecked, the builder leaves it and says so); (d) audit-pack CSV header: keep `is_emergency` as yes or blank, restore a blank `retro_overdue` for one more release (cycle-2 review C2-13).
- **R-179** Seed logins on a neutral domain (audit S5). Acceptance: seed members use `@example.com`; docs that quote the old addresses are updated; the commit gate stays green.

`schedule_threshold_days` (G1): left as built until the owner answers D18.

### W5-H documentation (low risk, runs after I reports) | none

Owns: `web/src/app/api/openapi.json/route.ts`; `web/src/app/llms.txt/route.ts`; `web/mcp/README.md` (tool table only; W5-F finished); new `docs/adr/0018-external-audit-anchor.md`; `docs/use-cases/` updates (UC for audit verification, evidence via agent, deletion of registers); `sprint-log/2026-10-18_m1-closeout/OWNER-VISIBLE.md`; the `UAT-PLAN.md` fill; `CUTOVER/11-AUDIT-GAPS.md` extension (migrations 0107 to 0112, order: apply migrations, then deploy; anchor setup is optional and last).

- Applies every `rtm/*-openapi-notes.md` from waves 1 and 2 (coverage tests must pass: this is why nobody edited those files earlier).

### W5-J post-release checks and rehearsal (low risk) | none | R-180

Owns: new `CUTOVER/12-POST-RELEASE-CHECKS.md`; new `web/scripts/local-db/rehearse-0107-0112.mjs` (loopback only); test `web/src/lib/governance/post-release-checks.test.ts`.

- **R-180** Read-only SQL checklist for the owner. Acceptance: (a) the file is plain SQL blocks the owner pastes into the Supabase SQL editor, each with what it checks, the expected result and what to do if not; every statement is `select` only (a test scans the file and fails on any `insert`, `update`, `delete`, `alter`, `drop`, `create`, `truncate`, `grant`); (b) checks: `pg_constraint.convalidated` for the four-eyes CHECKs (0089 and 0106 names), the implemented-after-decided CHECKs (0092), `deletion_requests` target type and approval-kind CHECKs (0102, 0112), `projects_lock_integrity` (0088); (c) lock rows: projects with `is_locked` and a null or nil-UUID `locked_by`, and the ERP-EMEA project by name pattern supplied as a parameter the owner edits; (d) migration 0106 counts: change requests in status `emergency`, requests with a retro column set, workspaces whose `work_event_rules` still hold a completed rule, pending expense deletions below `high_risk` over the threshold; (e) migration ledger rows 0087 to 0112 present in order with no gaps; (f) audit chain: gapless `chain_seq` per workspace (max equals count), rows with a null `row_hash`, the newest `audit.verified` row; (g) the anchor receipts table: latest status per workspace (only after the anchor is set up); (h) NO probe, request or script targets live; the file says so at the top.
- The rehearsal script applies 0107 to 0112 twice to the local database in order and prints row counts before and after, to prove idempotence and no data loss.

## Order, sizes and gates

| Wave | Builders | Migrations | R-IDs | Review |
|---|---|---|---|---|
| 1 | W5-A, W5-B, W5-C, W5-D (4) | 0107, 0108, 0109, 0110 | R-161 to R-167 | one review, one fix, verifier on A, B, C |
| 2 | W5-E, W5-F, W5-G (3) | 0111, 0112 | R-168 to R-177 | one review, one fix, verifier on E, G |
| 3 | W5-I, then W5-H and W5-J in parallel (3) | none | R-178 to R-180 | one review |

Release: migrations 0107 to 0112 are applied before the build serves traffic (the new routes call the RPCs). The anchor is optional and enabled last (`CUTOVER/13`); until the variable is set the Trust Center honestly says "not anchored". Tag the cycle as an annotated tag after the owner's PR yes (separate decision, per the standing merge rule).

## Not planned, with reason

| Item | Reason |
|---|---|
| Slack and Teams sync (A6) | needs the maintainer (new integrations) |
| OAuth (K4) | needs the maintainer (constitutional) |
| Q2 routine tier, UAT-018 | owner has not answered |
| B4 per-task baseline history | medium effort and its own scope; owner to decide whether the project-level history in R-173 is enough |
| Task backup owner (M6 note) | not in the requested scope; small, can follow |
| MCP policy tool (G1) | not in the requested scope; read-only policy tool is a follow-up |
| MCP access-review export (M5) | not in the requested scope |

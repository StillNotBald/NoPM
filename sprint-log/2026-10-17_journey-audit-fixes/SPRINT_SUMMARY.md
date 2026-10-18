# Sprint Summary — 2026-10-17_journey-audit-fixes

**TL;DR:** The journey map and the 2026-10-17 audit were turned into code: approving is now for admins and managers on every channel (decision 16), members log only their own hours (decision 17, to confirm), plus auth hardening, atomic governance writes, console controls for rebaselines, work-data fixes, and updated agent surfaces and docs. **Eleven migrations (0059–0067, 0069, 0071) are written and NOT applied: they must be applied before the build deploys** (`CUTOVER/08-JOURNEY-AUDIT-FIXES.md`).

## Declared goals
- Fix the findings of the journey audit that do not need an owner answer, and build the two decisions the owner gave (R-IDs: R-113 to R-119)
- Bring OpenAPI, `llms.txt`, MCP, CLI, requirements, use cases, user manual and runbooks in line with the behaviour (R-IDs: R-25, R-97, R-113)

## Actual outcomes

**Approvals (decision 16, ADR 0014, R-113).** `requireApprover` in deletion approve and reject, change-request decide, rebaseline sign-off and apply, timesheet approve, reject and reopen; 403 `role_not_permitted` "Only managers and admins can approve". Tokens are judged by their creator's current role. Database backstop: a trigger on `deletion_requests` (0061) and role checks inside the new RPCs (0062, 0063). `llms.txt` and OpenAPI no longer claim "agents never approve" (A1-6): approvals need an admin or manager human principal, and a PAT with an approve scope inherits its creator's current role.

**Time entries (decision 17, R-114).** `not_your_hours` 403 for a member logging or deleting someone else's hours; `task_id` must belong to the entry's project.

**Auth and tokens (D-ACC-1 to D-ACC-6, D-ACC-19, D-ACC-20; 0059, 0060; R-116).** A token stops authenticating when its creator's profile is gone or in another workspace; MFA disable needs a code, enrol while on is 409, TOTP replay guard, 10 attempts per 5 minutes shared by verify, challenge and disable; invite accept retry-safe; `account_exists` and `already_revoked` 409s; the shared demo login cannot mint tokens, invites or uploads; `Retry-After` on every 429; per-actor rate buckets with a workspace ceiling; failed bearer auth throttled per client address before the token lookup; audit actions `auth.signout`, `auth.mfa.verify_failed`, `auth.mfa.disable_failed`.

**Governance writes are all-or-nothing (A3-2, A3-3, D10, D11; 0062, 0063; R-118).** Rebaseline apply, sign-off, project lock, unlock and change-request decide are single RPCs with the audit row inside (`nopm_apply_rebaseline`, `nopm_signoff_rebaseline`, `nopm_lock_project`, `nopm_unlock_project_audited`, `nopm_decide_change_request`). A second pending rebaseline is a clean 409 `pending_rebaseline_exists` (D-GOV-4); apply on an unlocked project is 422 `project_not_locked`. The old RPCs are kept.

**Console (R-118, R-119).** Propose, sign off and apply on `/baselines`; the Unlock dialog lists the rebaselines it will cancel; the Lock dialog has an editable reason; approve controls are hidden from members; project deletion shows the child counts; timesheets can be resubmitted or reopened; the settings page asks for a code to turn two-step off.

**Deletion, documents, registers (0064, 0065; R-119).** Project deletion writes one audit row per cascade-deleted child; CR-/DEC-/DOC- numbers come from a counter and are never reused; text limits (10,000 / 100,000 / 2,000); document file removal audits first, then deletes the object; attach checks the storage path and a 25 MiB limit (also set on the bucket).

**Work data and idempotency (0066, 0067; R-115).** Risks, issues and milestones save all their fields; `program_id` on projects; `completion_pct` is calculated, not set; closed-sprint guard; expense date defaults to today; risk escalation on update; the task roll-up no longer bumps `projects.updated_at` (no false 412); `Idempotency-Key` on time entries, expenses, tasks and allocations.

**Clashes (ADR 0003 refreshed).** Auto-resolve is audited (`clash.auto_resolve`); a clash in `investigating` counts as open; a detector failure no longer fails a saved allocation (the response carries `warnings`).

**Lark and assistant (0069).** Atomic connector revoke; card catch-up on resume; a refused self-approval keeps the card usable; `connector_paused` on link-code; assistant demo quota gives 429 with `Retry-After` or 503, the ephemeral token lives 10 minutes and is revoked on every path (`assistant.token.mint` and `.revoke`).

**Audit (0071; R-117).** `audit_log.principal_id`, channel derived from the credential, `system:*` actors.

**Agent surfaces (this worker).**
- OpenAPI: every new field, header (`Idempotency-Key` as a shared parameter, `Retry-After`), status and error code above.
- `llms.txt`: same facts; the approver paragraph rewritten.
- MCP: seven MCP-only tools (`create_change_request`, `propose_rebaseline`, `sign_off_rebaseline`, `apply_rebaseline`, `submit_timesheet`, `create_decision`, `create_document`) in `MCP_GOVERNANCE_TOOLS`, deliberately NOT in the registry the assistant uses; the stdio server serves them. `web/src/lib/assistant/tools-mcp-governance.test.ts` locks them to the spec, the Zod validators and the assistant's scope ceiling.
- CLI: `--idempotency-key` on `time create`, `expenses create`, `tasks create`, `allocations create`; clean messages for the new 403 and for 429 with `Retry-After`; allocation warnings printed.

**Docs.** ADR 0014 (approver roles); ADR 0003 refreshed (target type `clash`, DELETE and member change also cascade, resolve audited); R-113 to R-119; UC-08, UC-10, UC-11, UC-12, UC-17, UC-19, UC-23 and the doc contradictions of D-ACC-22 (UC-18, UC-24, UC-25, the Lark guide); user manual (approvals, schedule and lock, admin); the leaver procedure in `docs/runbooks/user-provisioning.md` rewritten (D-ACC-1: do not delete the profile; revoke tokens, ban the login, set the role to viewer; feeds keep working by decision 9); `CUTOVER/08-JOURNEY-AUDIT-FIXES.md`; the ROADMAP backlog line for the owner questions.

## Review fix pass

R-1 to R-17 were fixed; R-18 is left for the owner as Q-REV-18. Behaviour added: Idempotency-Key errors (400 invalid_idempotency_key, 409 idempotency_in_progress, 422 idempotency_key_reused; keys scoped per workspace, actor and route, 24 h); 409 rebaseline_version_conflict on racing proposals; MFA enroll/verify/disable 403 demo_restricted for the shared demo login, disable by code or a challenge passed in the last 10 minutes; a PAT whose creator is now a viewer is read-only (403 forbidden_scope); failed bearer auth gets 429 with Retry-After once an address spends its budget (a valid token is never throttled); timesheet approve/reject database backstop (P0018 -> 403 role_not_permitted); audit rows written by database functions carry principal_id. Migrations are now 0059-0067, 0069, 0071-0074.

Local-stack proof: all migrations applied to a fresh local Supabase; probe-migrations 9/9, probe-four-eyes 28/28, probe-rls-direct-write 23/23.

## R-IDs touched
- R-113 → DONE (new): approver role rule
- R-114 → DONE (new): time-entry ownership
- R-115 → DONE (new): idempotency keys
- R-116 → DONE (new): MFA step-up
- R-117 → DONE (new): audit principal
- R-118 → DONE (new): rebaseline console controls and atomic governance RPCs
- R-119 → DONE (new): project-deletion child audit

## Files
- Migrations: `web/supabase/migrations/20261017000059` to `20261017000067`, `…069`, `…071` (11 files; no 0068 or 0070).
- Agent surfaces: `web/src/app/api/openapi.json/route.ts`, `web/src/app/llms.txt/route.ts`, `web/mcp/tools.mjs`, `web/mcp/server.mjs`, `web/mcp/README.md`, `cli/lib/api.mjs`, `cli/nopm.mjs`, `cli/commands/{time,expenses,tasks,allocations,approve}.mjs`.
- Docs: `docs/adr/0014-approver-roles.md`, `docs/adr/0003-audit-cascade.md`, `docs/runbooks/user-provisioning.md`, `docs/ROADMAP.md`, `docs/use-cases/UC-*.md`, `user-manual/**`, `CUTOVER/08-JOURNEY-AUDIT-FIXES.md`, `requirements/REQUIREMENTS.md`, `requirements/TRACEABILITY.md`.

## Tests / verification (gates)
- Rollout order: backup → pre-check → build without aliasing → `--atomic --dry-run` → `--atomic` apply → post-check → promote → smoke. **Migrations first, then the deploy.** All eleven are additive and the older RPCs are kept, so the previous build keeps working in between (one exception: 0061 refuses a non-approver's deletion decision).
- `npm run rtm:verify`: OK (109 R-IDs, 1130 code paths).
- Vitest on the agent-surface areas (`src/lib/api`, `src/app/llms.txt`, `src/lib/assistant`, `src/lib/review`, openapi, marketing): all pass except `marketing.test.ts` "transcript soft-wraps", which is a CRLF line-ending problem of the checkout, unrelated to this sprint.
- CLI: `npm test` in `cli/`, 54 of 54.
- ESLint on the agent-surface TypeScript files: clean.
- `node scripts/gen-metrics.mjs` was NOT regenerated: the script runs the whole suite and refuses to write while any test fails (the CRLF test above). `web/src/lib/metrics.gen.json` still reads 102 R-IDs; it should read 109 plus the new test count once the suite is green.
- Not run: the migrations against a database; the governed smoke of `CUTOVER/08`.

## Follow-ups
- Owner: confirm decision 17 (own hours only).
- Owner: answer the Priority 1 questions in `journeys/OPEN-QUESTIONS.md` (one ROADMAP line points there).
- Operator: run `CUTOVER/08-JOURNEY-AUDIT-FIXES.md`, then regenerate the proof metrics.
- Remote MCP (`/api/mcp`) still serves the shared registry only; registering `MCP_GOVERNANCE_TOOLS` there is a one-line change in `web/src/app/api/mcp/route.ts` (not done in this sprint).
- An in-app screen to change a role or remove a person is still missing (leavers are an operator task).

import { route } from "@/lib/api/handler";

export const runtime = "nodejs";

const TEXT = `# NoPM — agent API

## Base URL
https://stillnotbald.com/api

## Authentication
Every request (except /health and /api/openapi.json) requires:
  Authorization: Bearer <token>

Tokens are scoped Personal Access Tokens (PATs) with prefix npm_.
Scopes follow the pattern resource:action (e.g. task:read, project:write).
A token may hold multiple scopes. Admin/manager user sessions bypass scope checks for token management.
Tokens are SHA-256 hashed at rest and shown exactly once at creation time.

## Response shape
Success:   { "data": <object|array>, ["total": N, "page": N, "limit": N] }
Error:     { "error": "<message>", ["fields": [{"field": "...", "message": "..."}]] }

HTTP status codes: 200 ok, 201 created, 202 accepted, 204 no content,
  400 bad request, 401 unauthenticated, 403 forbidden (scope), 404 not found, 422 rule/validation error,
  429 rate limited (baseline workspace+actor-class limit, fixed 60s window; retry after the interval
  named in the error message; code: rate_limited).

## Pagination
Lists accept ?limit (1..100, default 20) and ?page (1-based).
Response includes total, page, limit alongside data.

## Field enums & formats (read this to avoid 422s)
Projects:    code REQUIRED on create (1-32 chars, short unique identifier, e.g. APOLLO); name REQUIRED.
             rag_status = not_started | red | amber | green | complete
             phase = initiation | planning | execution | monitoring | closing
             start_date / target_date = YYYY-MM-DD; currency = 3-letter ISO code.
Tasks:       name REQUIRED. status_type = backlog | unstarted | started | completed | canceled (default backlog)
             priority = low | medium | high | urgent (default medium)
             start_date / due_date = YYYY-MM-DD; completion_pct = integer 0-100.
Milestones:  name REQUIRED. status = not_started | on_track | at_risk | delayed | completed
             target_date = ISO 8601 datetime WITH offset (e.g. 2026-09-30T00:00:00Z); start_date = YYYY-MM-DD.
Risks:       title, severity, likelihood REQUIRED. severity / likelihood = low | medium | high | critical
             status = open | mitigating | closed | accepted (default open)
             raised_at / due_date = ISO 8601 datetime with offset.
Issues:      title, priority REQUIRED. priority = low | medium | high | urgent
             severity (optional) = low | medium | high | critical
             status = open | in_progress | resolved | closed (default open)
             resolution_eta / resolved_at = YYYY-MM-DD.
Programs:    name REQUIRED. rag_status = not_started | red | amber | green | complete (same domain as
             Projects — this value is the program's DECLARED health, set independently of the
             computed rollup from its child projects). owner_id, if set, must be a resource_members id
             (NOT a profiles id — same identity model as tasks.assignee_id since 0019).
Sprints:     project_id, name, start_date, end_date REQUIRED on create (goal optional). start_date /
             end_date = YYYY-MM-DD; end_date must be >= start_date. state = planned | active | closed
             — NEVER set via PATCH, only via POST /start (planned->active) and POST /close
             (active->closed). committed_points/committed_snapshot and completed_points/
             completed_snapshot are governed snapshots written once by /start and /close respectively
             — never recomputed by a later task edit.
Task deletion: body { "reason": "<why>" } is REQUIRED (it becomes the audit trail).
Project deletion: body { "reason": "<why>" } is REQUIRED (it becomes the audit trail).
Project unlock: body { "reason": "<why>" } is REQUIRED (R-83 — lock's reason stays optional; unlock's is not).
Change requests: title, category, priority, status REQUIRED on create; priority = low | medium | high | critical
             decision endpoint takes { "decision": "approve" | "reject" | "defer", "rationale": "..." }.
Task dependencies: type = FS | SS | FF | SF (default FS), lag_days integer (default 0).

## Maker-checker: task and project deletion
DELETE /tasks/{id} and DELETE /projects/{id} do NOT immediately delete the target.
Task deletion requires scope task:delete:request; project deletion requires scope
project:delete:request. Both create a deletion_request with status=pending (target_type=task
or target_type=project) and return 202 Accepted. A DIFFERENT token (approver != requester) with
the scope matching the request's target_type must POST /deletion-requests/{id}/approve to
execute the deletion — task:delete:approve for task requests, project:delete:approve for
project requests (per-type gate; the route dispatches to the matching commit path).
Self-approval is rejected with 403; self-rejection with 422 (four-eyes binds both decisions).
A checker cancels via POST /deletion-requests/{id}/reject; the ORIGINAL requester may cancel
their own pending request via POST /deletion-requests/{id}/withdraw (per-type maker scope:
task:delete:request or project:delete:request).
Owner-locked (Decision 3, requirements/devops-wave1/README.md): maker-checker extends to
PROJECTS ONLY — milestones/risks/issues stay single-step hard deletes and never create a
deletion_request row.

## Audit log
Every mutation writes exactly one immutable row to the audit_log table.
Read it at GET /audit (scope: audit:read).

Provenance (R-82): send X-NoPM-Client: cli|mcp|assistant|api|ui to declare which
surface made the call — it is recorded on the audit row as channel but is NOT an
authorization input (token identity stays authoritative); omitted it defaults to
'api' for a Bearer/token caller. Send X-Request-Id: <up to 64 chars, [A-Za-z0-9._-]>
to correlate a request with its audit row (request_id); the server echoes it back
as the X-Request-Id response header, generating one for you when you don't send it.

Tail the log (R-85): GET /audit accepts ?since (ISO 8601 timestamp, 422 if unparsable),
?after_id (uuid of a row you already saw — its created_at becomes a strict lower
bound; 404 if that id doesn't exist in your workspace), and ?order (asc|desc, default
desc; 422 otherwise). since and after_id may be combined. To poll forward in time:
  GET /api/audit?since=<iso>&order=asc&limit=100
then remember the created_at (or id, as after_id) of the last row you saw and use it
as the next poll's cursor.

---

## Endpoint index

GET    /health                             — scope:none — liveness probe, public
GET    /me                                 — scope:any  — resolve the current actor (type, id, workspaceId, scopes)
PATCH  /me                                 — user session only — update own profile
GET    /me/preferences                     — user session only — get DB-persisted display config (columns/groupBy per register, density, dateDisplay, defaultLanding) — L-39, unaudited (ADR 0009). Response includes demo (true for the shared demo login — treat as cookie-only, never write DB prefs for it).
PUT    /me/preferences                     — user session only — merge display config onto the existing stored config (not a verbatim replace). Body { config }; unknown keys stripped (not rejected); top-level keys in the body override, keys omitted from the body are preserved; columns/groupBy merge per register key; no way to delete a saved key. 10KB serialized-size cap checked against the merged result, 422 on an unrecognised value for a whitelisted key or over the size cap.

POST   /auth/demo-login                    — public — start a demo viewer session
POST   /auth/signout                       — user session — end the session
GET    /auth/mfa                           — user session — get MFA enabled status for the current user
POST   /auth/mfa/enroll                    — user session — begin TOTP enrollment (returns secret + otpauth URI)
POST   /auth/mfa/verify                    — user session — confirm TOTP code, enable MFA, receive backup codes (shown once)
POST   /auth/mfa/disable                   — user session — disable MFA and clear TOTP secret

GET    /tokens                             — admin/manager session — list API tokens (token_hash never returned)
POST   /tokens                             — admin/manager session — mint a new token (raw value returned once)
DELETE /tokens/{id}                        — admin/manager session — revoke a token

GET    /invites                            — admin/manager session — list link invites (L-47/L-48). status is DERIVED (pending|accepted|revoked|expired), never a stored column. Optional ?status= filter.
POST   /invites                            — admin/manager session — create a link invite. Role-escalation cap (D5): invite.role must be <= the creator's own rank (viewer<member<manager<admin) — 422 if exceeded. Token prefix npi_. expires_at = now + 7 days. invite_url returned ONCE.
POST   /invites/{id}/revoke                — admin/manager session — revoke a pending invite (422 if not pending)
POST   /invites/accept                     — scope:none — public, unauthenticated. Provisions a brand-new login (createUser THEN the atomic nopm_accept_invite RPC — writes profiles + resource_members + marks the invite + 2 audit rows in one transaction). Body: { token, password (>=12 chars), display_name } — NO email field, the invite's own email is always used. Rate-limited 10/min per IP (this endpoint has no actor to key the baseline limiter on). No session is returned — sign in via /login afterwards. Anti-enumeration (T3, F2c-mini): not-found/already-used/revoked/expired ALL return the same uniform 422 (never a distinct 404) — the /invite/[token] page keeps distinct friendly copy, an intentional asymmetry.

GET    /projects                           — scope:project:read  — list projects in workspace. Filters: ?source, ?external_ref (complement seam, R-81 — both exact-match; NoPM is the governed record beside Jira/Slack/Teams, not a replacement for them).
POST   /projects                           — scope:project:write — create a project
GET    /projects/{id}                      — scope:project:read  — get a project
PATCH  /projects/{id}                      — scope:project:write — update a project
DELETE /projects/{id}                      — scope:project:delete:request — request project deletion (maker step, returns 202, creates deletion_request)
POST   /projects/{id}/lock                 — scope:project:write — lock the project timeline (Gantt becomes read-only)
POST   /projects/{id}/unlock               — scope:project:write — unlock the project timeline; body { "reason": "<why>" } is REQUIRED (R-83 — recorded in the audit trail's after.unlock_reason, not stored on the row)

GET    /programs                           — scope:program:read  — list programs in workspace
POST   /programs                           — scope:program:write — create a program (a named, ownable container above projects — L-01)
GET    /programs/{id}                      — scope:program:read  — get a program
PATCH  /programs/{id}                      — scope:program:write — update a program (rag_status here is DECLARED health, independent of the computed child rollup — L-02)
DELETE /programs/{id}                      — scope:program:write — delete a program (plain hard delete, single-step, audited — NOT maker-checker; never deletes child projects, they just lose program_id)

GET    /sprints                            — scope:sprint:read  — list sprints in workspace. Filters: ?project_id, ?state=planned|active|closed. Ordered start_date desc.
POST   /sprints                            — scope:sprint:write — create a sprint under a project (created in state=planned) — L-17
GET    /sprints/{id}                       — scope:sprint:read  — get a sprint
PATCH  /sprints/{id}                       — scope:sprint:write — update name/goal/dates only (state is NEVER settable here — use /start and /close). A closed sprint 422s every PATCH.
DELETE /sprints/{id}                       — scope:sprint:write — delete a sprint (plain hard delete, single-step, audited — NOT maker-checker). Only while state=planned AND no tasks attached (422 otherwise).
POST   /sprints/{id}/start                 — scope:sprint:write — governed planned->active transition; snapshots committed_points/committed_snapshot from every currently-attached task, written once, never recomputed (L-18)
POST   /sprints/{id}/close                 — scope:sprint:write — governed active->closed transition; snapshots completed_points/completed_snapshot from attached tasks with status_type=completed, written once, never recomputed (L-18)
POST   /sprints/{id}/tasks                 — scope:sprint:write — attach a task to a sprint (task must be in this workspace AND the sprint's own project — 422 otherwise); 422 if sprint is closed
DELETE /sprints/{id}/tasks                 — scope:sprint:write — detach a task from a sprint. ?task_id=<uuid> REQUIRED. The task must currently be attached to THIS sprint (422 otherwise); 422 if sprint is closed

GET    /saved-views                        — scope:saved_view:read  — list saved views (own personal + all shared in workspace, never another identity's personal view — L-41). Optional ?register=tasks|risks|issues|clashes|...
POST   /saved-views                        — scope:saved_view:write — save the current filters+sort+columns+groupBy as a view (L-05). Token/agent callers are always forced to scope=shared (no owning identity for personal).
GET    /saved-views/{id}                   — scope:saved_view:read  — get a saved view (404, not 403, if it's personal and not yours)
PATCH  /saved-views/{id}                   — scope:saved_view:write — update/share/protect a saved view; owner or admin only (403 otherwise). A protected view 403s a config PATCH unless the same call also unprotects it (L-07). Scope/protected toggles are audited (L-06/L-07).
DELETE /saved-views/{id}                   — scope:saved_view:write — delete a saved view (plain hard delete, single-step, audited — NOT maker-checker)
POST   /saved-views/{id}/duplicate         — scope:saved_view:write — clone any visible view (incl. a protected one) into a fresh, unprotected personal copy owned by the caller — user sessions only

GET    /projects/{id}/milestones           — scope:milestone:read  — list milestones for a project
POST   /projects/{id}/milestones           — scope:milestone:write — create a milestone under a project
GET    /milestones/{id}                    — scope:milestone:read  — get a milestone
PATCH  /milestones/{id}                    — scope:milestone:write — update a milestone
DELETE /milestones/{id}                    — scope:milestone:write — delete a milestone

GET    /tasks                              — scope:task:read  — cross-project task list (L-04), workspace-scoped not per-project. Filters: project_id/assignee_id/status_type/priority/due_before/due_after/overdue/q/source/external_ref (source/external_ref: complement seam, R-81 — both exact-match). Sort (L-10): ?sort=field:asc|desc against due_date|priority|status_type|name|created_at|completion_pct — unknown field/direction 422s. Reused by GET /export?entity=tasks.
GET    /projects/{id}/tasks                — scope:task:read  — list tasks for a project
POST   /projects/{id}/tasks                — scope:task:write — create a task in a project
GET    /tasks/{id}                         — scope:task:read  — get a task
PATCH  /tasks/{id}                         — scope:task:write — update a task (Kanban moves are audited)
DELETE /tasks/{id}                         — scope:task:delete:request — request task deletion (maker step, returns 202, creates deletion_request)
GET    /tasks/{id}/dependencies            — scope:task:read  — list a task's predecessors
POST   /tasks/{id}/dependencies            — scope:task:write — add a dependency (predecessor_id, type FS|SS|FF|SF, lag_days)
DELETE /tasks/{id}/dependencies            — scope:task:write — remove a dependency (predecessor_id in body)

GET    /projects/{id}/risks                — scope:risk:read  — list risks for a project. Filters: ?source, ?external_ref (complement seam, R-81 — both exact-match).
POST   /projects/{id}/risks                — scope:risk:write — create a risk under a project
GET    /risks/{id}                         — scope:risk:read  — get a risk
PATCH  /risks/{id}                         — scope:risk:write — update a risk
DELETE /risks/{id}                         — scope:risk:write — delete a risk

GET    /projects/{id}/issues               — scope:issue:read  — list issues for a project. Filters: ?source, ?external_ref (complement seam, R-81 — both exact-match).
POST   /projects/{id}/issues               — scope:issue:write — create an issue under a project
GET    /issues/{id}                        — scope:issue:read  — get an issue
PATCH  /issues/{id}                        — scope:issue:write — update an issue
DELETE /issues/{id}                        — scope:issue:write — delete an issue

GET    /clashes                            — scope:clash:read  — list clashes (schedule/resource/dependency conflicts, cross-project)
POST   /clashes                            — scope:clash:write — create a clash record
GET    /clashes/{id}                       — scope:clash:read  — get a clash
PATCH  /clashes/{id}                       — scope:clash:write — update a clash
DELETE /clashes/{id}                       — scope:clash:write — delete a clash

GET    /resources                          — scope:resource:read  — list resource members (people with cost rates and capacity)
POST   /resources                          — scope:resource:write — create a resource member
GET    /resources/{id}                     — scope:resource:read  — get a resource member
PATCH  /resources/{id}                     — scope:resource:write — update a resource member
DELETE /resources/{id}                     — scope:resource:write — delete a resource member

GET    /allocations                        — scope:resource:read  — list allocations
POST   /allocations                        — scope:resource:write — create an allocation (triggers over-allocation clash detection)
GET    /allocations/{id}                   — scope:resource:read  — get an allocation
PATCH  /allocations/{id}                   — scope:resource:write — update an allocation (re-runs clash detection)
DELETE /allocations/{id}                   — scope:resource:write — delete an allocation

GET    /time-entries                       — scope:time:read  — list time entries (?project_id, ?member_id, ?date_from/?date_to entry_date window, ?billable filters available)
POST   /time-entries                       — scope:time:write — log a time entry (cost auto-computed as hours * member.cost_rate; billable defaults from the project's default_billable when omitted — L-29); 422 if the entry's week is locked (an approved timesheet submission covers it — R-76/L-32)
DELETE /time-entries/{id}                  — scope:time:write — delete a time entry; 422 if the entry's week is locked (same period-close lock as POST)

GET    /timesheet-submissions              — scope:time:read    — list timesheet submissions. Filters: ?member_id, ?status=submitted|approved|rejected, ?period=YYYY-MM-DD (period_start exact match). Ordered submitted_at desc.
POST   /timesheet-submissions              — scope:time:submit  — submit a weekly timesheet for a member (four-eyes maker step, L-31); period_start must be a Monday; snapshots hours_total/entry_count from that week's time_entries, never recomputed afterwards; 422 if nothing to submit or an open submission already exists for this member+period
POST   /timesheet-submissions/{id}/decision — scope:time:approve — approve|reject|reopen a timesheet submission (four-eyes checker step, L-31; reopen is the R-76/L-32 period-close-lock unlock verb); the decider must differ from the submitter (compound id+type comparison, guard symmetry on ALL THREE verbs — 403 otherwise); approve/reject require status=submitted, reopen requires the INVERSE (status=approved); rationale required on reject and reopen; reopen reverts to submitted and clears the prior decision

GET    /projects/{id}/budget               — scope:budget:read  — get budget summary (planned, committed, actual, variance, burn_pct)
PUT    /projects/{id}/budget               — scope:budget:write — upsert project budget (planned_amount, committed_amount, currency)
PATCH  /projects/{id}/budget               — scope:budget:write — upsert project budget (alias for PUT)
GET    /projects/{id}/expenses             — scope:budget:read  — list expenses for a project
POST   /projects/{id}/expenses             — scope:budget:write — create an expense for a project
DELETE /expenses/{id}                      — scope:budget:write — delete an expense

GET    /documents                          — scope:document:read  — list documents (?project_id, ?doc_type, ?status filters)
POST   /documents                          — scope:document:write — create a document record
GET    /documents/{id}                     — scope:document:read  — get a document
PATCH  /documents/{id}                     — scope:document:write — update a document
DELETE /documents/{id}                     — scope:document:write — delete a document
GET    /documents/{id}/file                — scope:document:read  — download the attached file
POST   /documents/{id}/file                — scope:document:write — attach an uploaded file (path, file_name, mime_type, file_size)
DELETE /documents/{id}/file                — scope:document:write — detach the file
POST   /documents/{id}/file/sign           — scope:document:write — get a signed upload URL (max 25 MiB)

GET    /projects/{id}/decisions            — scope:decision:read  — list decisions for a project. Filters: ?source, ?external_ref (complement seam, R-81 — both exact-match).
POST   /projects/{id}/decisions            — scope:decision:write — record a decision
GET    /decisions/{id}                     — scope:decision:read  — get a decision
PATCH  /decisions/{id}                     — scope:decision:write — update a decision
DELETE /decisions/{id}                     — scope:decision:write — delete a decision

GET    /projects/{id}/change-requests      — scope:change:read  — list change requests for a project
POST   /projects/{id}/change-requests      — scope:change:write — raise a change request
GET    /change-requests/{id}               — scope:change:read  — get a change request
PATCH  /change-requests/{id}               — scope:change:write — update a change request
DELETE /change-requests/{id}               — scope:change:write — delete a change request
POST   /change-requests/{id}/decision      — scope:change:decide — decide a change request (approve | reject | defer + rationale, audited); the deciding actor must differ from the requester on BOTH id and type (four-eyes) — 403 otherwise

GET    /projects/{id}/rebaselines          — scope:project:read  — list rebaseline records for a project
POST   /projects/{id}/rebaselines          — scope:project:write — propose a rebaseline (reason required)
POST   /rebaselines/{id}/signoff           — scope:rebaseline:approve — sign off a rebaseline (four-eyes)
POST   /rebaselines/{id}/apply             — scope:rebaseline:approve — apply a signed-off rebaseline

GET    /deletion-requests                  — scope:task:read or audit:read — list deletion requests (?status=pending|approved|rejected|committed|withdrawn; target_type=task|project)
POST   /deletion-requests/{id}/approve     — scope:<type>:delete:approve — approve and execute a pending deletion (per-type gate: task:delete:approve or project:delete:approve; four-eyes: approver != requester)
POST   /deletion-requests/{id}/reject      — scope:<type>:delete:approve — reject a pending deletion request (per-type gate; four-eyes: no self-rejection)
POST   /deletion-requests/{id}/withdraw    — scope:task:delete:request — withdraw your OWN pending deletion request (maker step; task or project target)

GET    /notifications                      — scope:notification:read — list in-app notifications for the actor
PATCH  /notifications/{id}                 — scope:notification:read — mark a notification read/unread
POST   /notifications/read-all             — scope:notification:read — mark all notifications read

GET    /audit                              — scope:audit:read — query immutable audit log (?target_type, ?target_id, ?action, ?actor_id, ?channel one of ui|api|cli|mcp|assistant — R-82, unrecognized values ignored; ?since ISO 8601 timestamp — 422 if unparsable, ?after_id uuid of a row already seen — 404 if absent from this workspace, ?order asc|desc default desc — 422 otherwise; since/after_id combine — R-85). Each row carries channel (declared/caller-asserted client, NOT an authorization input) and request_id (per-request correlation id, also echoed as the X-Request-Id response header) — both nullable for rows predating migration 20260906000042_audit_channel.sql.
GET    /search                             — scope:project:read — full-workspace search (?q=) across projects, tasks, programs, sprints, risks, issues, clashes, documents, change requests, decisions
GET    /timeline                           — scope:project:read — the Mainline portfolio graph (every artifact + task-dependency DAG in one governed read)
GET    /metrics/time-in-status             — scope:task:read — per-task status-span history (?task_id, ?project_id, ?date_from/?date_to entered_at window, ?limit)

GET    /export                             — scope:<entity>:read — governed CSV export (L-27/L-36). ?entity=tasks|risks|issues|clashes|audit|time_entries|programs (required). Reuses the SAME filter/sort params as each entity's list API (tasks: project_id/assignee_id/status_type/priority/due_before/due_after/overdue/q/sort; risks/issues: project_id REQUIRED + status/severity(/priority for issues)/sort; clashes: none; time_entries: project_id/member_id/date_from/date_to/billable; audit: target_type/target_id/action/actor_id/channel (R-82)/since/order (R-85, lenient — bad value dropped, not 422; after_id NOT supported here); programs: none, fixed name asc). Streams text/csv, filename nopm-<entity>-<date>.csv (server-derived date). entity=audit CSV columns include channel and request_id. Capped at 10,000 rows (truncation noted in a final CSV row + server log). Writes one audit_log row per export (action export.csv, target_type=entity) — exporting the audit log is itself audited.

GET    /reports/deck                       — scope:audit:read — portfolio deck (?format=pptx|pdf|html)
POST   /reports/deck                       — scope:audit:read — portfolio deck (POST variant)
GET    /reports/project/{id}               — scope:audit:read — single-project report (?format=pptx|pdf|html)
POST   /reports/project/{id}               — scope:audit:read — single-project report (POST variant)

POST   /assistant/chat                     — user session only — BYOK governed assistant turn (SSE or JSON)
GET    /assistant/conversations            — user session only — list saved assistant conversations
GET    /assistant/conversations/{id}       — user session only — get one conversation
GET    /assistant/credentials              — user session only — check stored provider credential status (never returns the key)
PUT    /assistant/credentials              — user session only — store a provider API key (AES-256-GCM at rest)
DELETE /assistant/credentials              — user session only — remove the stored key

GET    /api/openapi.json                   — scope:none — OpenAPI 3.1 spec for this API (public)

---

## MCP server

NoPM ships a native Model Context Protocol (MCP) server at web/mcp/server.mjs.
It exposes 24 governed tools (list/get/create/update across the core modules, plus
workspace search, budget, clashes, resources, and the audit log) over STDIO so any
MCP client (Claude Desktop, Claude Code, Cursor, etc.) can drive NoPM as an agent.
Tool schemas are generated from the same registry the in-app assistant uses and are
lock-tested against the API's Zod validators. Capabilities are bounded by the PAT
scopes; all writes are audited; task and project deletion both go through maker-checker
(the assistant/MCP tool set can only request deletion — approve scopes are never granted).
See web/mcp/README.md for setup instructions.

---

## Maker-checker note (expanded)

Task deletion AND project deletion are intentionally two-step to provide change-control
traceability. Owner-locked (Decision 3, requirements/devops-wave1/README.md): this flow
extends to PROJECTS ONLY — milestones/risks/issues stay single-step hard deletes and never
create a deletion_request row.

1. Maker step   — task: token with scope task:delete:request calls DELETE /tasks/{id}
                  project: token with scope project:delete:request calls DELETE /projects/{id}
                  Both take a JSON body containing "reason" (REQUIRED)
                  Both return 202 with a deletion_request object (status=pending,
                  target_type=task or target_type=project)
                  The target is NOT deleted yet.

2. Checker step — a DIFFERENT token with the scope matching the request's
                  target_type (task:delete:approve or project:delete:approve) calls
                  POST /deletion-requests/{id}/approve
                  The API enforces approver != requester (403 on self-approval).
                  The route dispatches by the request's target_type to the matching
                  atomic commit RPC (nopm_commit_task_deletion / nopm_commit_project_deletion).
                  On success the target is deleted, the deletion_request moves to
                  status=committed, and two audit_log rows are written:
                  task.delete or project.delete, and deletion_request.approved.
                  Project deletions also 422 as PROJECT_LOCKED if the project's schedule
                  was frozen after the deletion was requested (checked at commit time only —
                  unlike task deletion, the project maker step does not pre-check is_locked).

To cancel instead: a DIFFERENT checker POSTs /deletion-requests/{id}/reject (self-rejection
is 422), or the original requester POSTs /deletion-requests/{id}/withdraw (their one
permitted self-act — cancels without a decision, audited as deletion_request.withdrawn).
`;

/** Exported for llms-coverage.test.ts — locks this index to the OpenAPI spec. */
export const textForTesting = TEXT;

export const GET = route(
  async () =>
    new Response(TEXT, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
  { auth: false },
);

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
  400 bad request, 401 unauthenticated, 403 forbidden (scope), 404 not found, 422 rule/validation error.

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
Task deletion: body { "reason": "<why>" } is REQUIRED (it becomes the audit trail).
Change requests: title, category, priority, status REQUIRED on create; priority = low | medium | high | critical
             decision endpoint takes { "decision": "approve" | "reject" | "defer", "rationale": "..." }.
Task dependencies: type = FS | SS | FF | SF (default FS), lag_days integer (default 0).

## Maker-checker: task deletion
DELETE /tasks/{id} does NOT immediately delete the task.
It requires scope task:delete:request and creates a deletion_request with status=pending.
Returns 202 Accepted. A DIFFERENT token (approver != requester) with scope task:delete:approve
must POST /deletion-requests/{id}/approve to execute the deletion.
Self-approval is rejected with 403; self-rejection with 422 (four-eyes binds both decisions).
A checker cancels via POST /deletion-requests/{id}/reject; the ORIGINAL requester may cancel
their own pending request via POST /deletion-requests/{id}/withdraw (scope task:delete:request).

## Audit log
Every mutation writes exactly one immutable row to the audit_log table.
Read it at GET /audit (scope: audit:read).

---

## Endpoint index

GET    /health                             — scope:none — liveness probe, public
GET    /me                                 — scope:any  — resolve the current actor (type, id, workspaceId, scopes)
PATCH  /me                                 — user session only — update own profile

POST   /auth/demo-login                    — public — start a demo viewer session
POST   /auth/signout                       — user session — end the session
GET    /auth/mfa                           — user session — get MFA enabled status for the current user
POST   /auth/mfa/enroll                    — user session — begin TOTP enrollment (returns secret + otpauth URI)
POST   /auth/mfa/verify                    — user session — confirm TOTP code, enable MFA, receive backup codes (shown once)
POST   /auth/mfa/disable                   — user session — disable MFA and clear TOTP secret

GET    /tokens                             — admin/manager session — list API tokens (token_hash never returned)
POST   /tokens                             — admin/manager session — mint a new token (raw value returned once)
DELETE /tokens/{id}                        — admin/manager session — revoke a token

GET    /projects                           — scope:project:read  — list projects in workspace
POST   /projects                           — scope:project:write — create a project
GET    /projects/{id}                      — scope:project:read  — get a project
PATCH  /projects/{id}                      — scope:project:write — update a project
DELETE /projects/{id}                      — scope:project:write — hard delete a project
POST   /projects/{id}/lock                 — scope:project:write — lock the project timeline (Gantt becomes read-only)
POST   /projects/{id}/unlock               — scope:project:write — unlock the project timeline

GET    /projects/{id}/milestones           — scope:milestone:read  — list milestones for a project
POST   /projects/{id}/milestones           — scope:milestone:write — create a milestone under a project
GET    /milestones/{id}                    — scope:milestone:read  — get a milestone
PATCH  /milestones/{id}                    — scope:milestone:write — update a milestone
DELETE /milestones/{id}                    — scope:milestone:write — delete a milestone

GET    /projects/{id}/tasks                — scope:task:read  — list tasks for a project
POST   /projects/{id}/tasks                — scope:task:write — create a task in a project
GET    /tasks/{id}                         — scope:task:read  — get a task
PATCH  /tasks/{id}                         — scope:task:write — update a task (Kanban moves are audited)
DELETE /tasks/{id}                         — scope:task:delete:request — request task deletion (maker step, returns 202, creates deletion_request)
GET    /tasks/{id}/dependencies            — scope:task:read  — list a task's predecessors
POST   /tasks/{id}/dependencies            — scope:task:write — add a dependency (predecessor_id, type FS|SS|FF|SF, lag_days)
DELETE /tasks/{id}/dependencies            — scope:task:write — remove a dependency (predecessor_id in body)

GET    /projects/{id}/risks                — scope:risk:read  — list risks for a project
POST   /projects/{id}/risks                — scope:risk:write — create a risk under a project
GET    /risks/{id}                         — scope:risk:read  — get a risk
PATCH  /risks/{id}                         — scope:risk:write — update a risk
DELETE /risks/{id}                         — scope:risk:write — delete a risk

GET    /projects/{id}/issues               — scope:issue:read  — list issues for a project
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

GET    /time-entries                       — scope:time:read  — list time entries (?project_id and ?member_id filters available)
POST   /time-entries                       — scope:time:write — log a time entry (cost auto-computed as hours * member.cost_rate)
DELETE /time-entries/{id}                  — scope:time:write — delete a time entry

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

GET    /projects/{id}/decisions            — scope:decision:read  — list decisions for a project
POST   /projects/{id}/decisions            — scope:decision:write — record a decision
GET    /decisions/{id}                     — scope:decision:read  — get a decision
PATCH  /decisions/{id}                     — scope:decision:write — update a decision
DELETE /decisions/{id}                     — scope:decision:write — delete a decision

GET    /projects/{id}/change-requests      — scope:change:read  — list change requests for a project
POST   /projects/{id}/change-requests      — scope:change:write — raise a change request
GET    /change-requests/{id}               — scope:change:read  — get a change request
PATCH  /change-requests/{id}               — scope:change:write — update a change request
DELETE /change-requests/{id}               — scope:change:write — delete a change request
POST   /change-requests/{id}/decision      — scope:change:write — decide a change request (approve | reject | defer + rationale, audited)

GET    /projects/{id}/rebaselines          — scope:project:read  — list rebaseline records for a project
POST   /projects/{id}/rebaselines          — scope:project:write — propose a rebaseline (reason required)
POST   /rebaselines/{id}/signoff           — scope:rebaseline:approve — sign off a rebaseline (four-eyes)
POST   /rebaselines/{id}/apply             — scope:rebaseline:approve — apply a signed-off rebaseline

GET    /deletion-requests                  — scope:task:read or audit:read — list deletion requests (?status=pending|approved|rejected|committed|withdrawn)
POST   /deletion-requests/{id}/approve     — scope:task:delete:approve — approve and execute a pending deletion (four-eyes: approver != requester)
POST   /deletion-requests/{id}/reject      — scope:task:delete:approve — reject a pending deletion request (four-eyes: no self-rejection)
POST   /deletion-requests/{id}/withdraw    — scope:task:delete:request — withdraw your OWN pending deletion request (maker step)

GET    /notifications                      — scope:notification:read — list in-app notifications for the actor
PATCH  /notifications/{id}                 — scope:notification:read — mark a notification read/unread
POST   /notifications/read-all             — scope:notification:read — mark all notifications read

GET    /audit                              — scope:audit:read — query immutable audit log (?target_type, ?target_id, ?action, ?actor_id)
GET    /search                             — scope:project:read — full-workspace search (?q=) across projects, tasks, risks, issues, clashes, documents, change requests, decisions
GET    /timeline                           — scope:project:read — the Mainline portfolio graph (every artifact + task-dependency DAG in one governed read)

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
It exposes 23 governed tools (list/get/create/update across the core modules, plus
workspace search, budget, clashes, resources, and the audit log) over STDIO so any
MCP client (Claude Desktop, Claude Code, Cursor, etc.) can drive NoPM as an agent.
Tool schemas are generated from the same registry the in-app assistant uses and are
lock-tested against the API's Zod validators. Capabilities are bounded by the PAT
scopes; all writes are audited; task deletion goes through maker-checker.
See web/mcp/README.md for setup instructions.

---

## Maker-checker note (expanded)

Task deletion is intentionally two-step to provide change-control traceability:

1. Maker step   — token with scope task:delete:request calls DELETE /tasks/{id}
                  with a JSON body containing "reason" (REQUIRED)
                  Returns 202 with a deletion_request object (status=pending)
                  The task is NOT deleted yet.

2. Checker step — a DIFFERENT token with scope task:delete:approve calls
                  POST /deletion-requests/{id}/approve
                  The API enforces approver != requester (403 on self-approval).
                  On success the task is deleted, the deletion_request moves to
                  status=committed, and two audit_log rows are written:
                  task.delete and deletion_request.approved.

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

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

## Maker-checker: task deletion
DELETE /tasks/{id} does NOT immediately delete the task.
It requires scope task:delete:request and creates a deletion_request with status=pending.
Returns 202 Accepted. A DIFFERENT token (approver != requester) with scope task:delete:approve
must POST /deletion-requests/{id}/approve to execute the deletion.
Self-approval is rejected with 403. Use POST /deletion-requests/{id}/reject to cancel.

## Audit log
Every mutation writes exactly one immutable row to the audit_log table.
Read it at GET /audit (scope: audit:read).

---

## Endpoint index

GET    /health                             — scope:none — liveness probe, public
GET    /me                                 — scope:any  — resolve the current actor (type, id, workspaceId, scopes)

GET    /tokens                             — scope:admin/manager session — list API tokens (token_hash never returned)
POST   /tokens                             — scope:admin/manager session — mint a new token (raw value returned once)
DELETE /tokens/{id}                        — scope:admin/manager session — revoke a token

GET    /projects                           — scope:project:read  — list projects in workspace
POST   /projects                           — scope:project:write — create a project
GET    /projects/{id}                      — scope:project:read  — get a project
PATCH  /projects/{id}                      — scope:project:write — update a project
DELETE /projects/{id}                      — scope:project:write — hard delete a project

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

GET    /deletion-requests                  — scope:task:read or audit:read — list deletion requests (?status=pending|approved|rejected|committed)
POST   /deletion-requests/{id}/approve     — scope:task:delete:approve — approve and execute a pending deletion (four-eyes: approver != requester)
POST   /deletion-requests/{id}/reject      — scope:task:delete:approve — reject a pending deletion request

GET    /audit                              — scope:audit:read — query immutable audit log (?target_type, ?target_id, ?action, ?actor_id)

GET    /auth/mfa                           — scope:user session — get MFA enabled status for the current user
POST   /auth/mfa/enroll                    — scope:user session — begin TOTP enrollment (returns secret + otpauth URI)
POST   /auth/mfa/verify                    — scope:user session — confirm TOTP code, enable MFA, receive backup codes (shown once)
POST   /auth/mfa/disable                   — scope:user session — disable MFA and clear TOTP secret

GET    /api/openapi.json                   — scope:none — OpenAPI 3.1 spec for this API (public)

---

## MCP server

NoPM ships a native Model Context Protocol (MCP) server at web/mcp/server.mjs.
It exposes the governed tool set above over STDIO so any MCP client (Claude Desktop, Cursor, etc.)
can drive NoPM as an agent. Capabilities are bounded by the PAT scopes; all writes are audited;
task deletion goes through maker-checker. See web/mcp/README.md for setup instructions.

---

## Maker-checker note (expanded)

Task deletion is intentionally two-step to provide change-control traceability:

1. Maker step   — token with scope task:delete:request calls DELETE /tasks/{id}
                  (optionally with a JSON body containing "reason")
                  Returns 202 with a deletion_request object (status=pending)
                  The task is NOT deleted yet.

2. Checker step — a DIFFERENT token with scope task:delete:approve calls
                  POST /deletion-requests/{id}/approve
                  The API enforces approver != requester (403 on self-approval).
                  On success the task is deleted, the deletion_request moves to
                  status=committed, and two audit_log rows are written:
                  task.delete and deletion_request.approved.

To cancel instead: POST /deletion-requests/{id}/reject (same scope, self-rejection allowed).
`;

export const GET = route(
  async () =>
    new Response(TEXT, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
  { auth: false },
);

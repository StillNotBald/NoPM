import { route } from "@/lib/api/handler";
// The single tool registry shared with the stdio MCP server, the remote /mcp route and the
// in-app assistant — the tool count below is read from it so it cannot drift.
import { TOOL_REGISTRY } from "../../../mcp/tools.mjs";

export const runtime = "nodejs";

const TEXT = `# NoPM — agent API

## Base URL
https://stillnotbald.com/api

## Authentication
Every request (except the public routes below) requires:
  Authorization: Bearer <token>

Tokens are scoped Personal Access Tokens (PATs) with prefix npm_.
Scopes follow the pattern resource:action (e.g. task:read, project:write).
A token may hold multiple scopes. Admin/manager user sessions bypass scope checks for token management.
Tokens are SHA-256 hashed at rest and shown exactly once at creation time.
A browser session (cookie) may not write cross-site: a POST/PUT/PATCH/DELETE carrying an Origin header that is
not this site is refused 403 (code bad_origin). Bearer-token requests are never origin-checked.
A malformed id (not a UUID) in a path is 404 not_found; a malformed value in a query filter or body is 422
validation_failed.
Wildcard scopes (* and resource:*) NEVER grant the four approve/decide scopes: task:delete:approve,
project:delete:approve, change:decide, rebaseline:approve. Each must be granted by exact name,
and the token's creator must currently be an admin or manager for it to take effect (403 role_not_permitted).

Retries and limits: POST /projects/{id}/expenses, POST /projects/{id}/tasks and
POST /allocations accept an Idempotency-Key header (1-200 chars of A-Za-z0-9_.:-; remembered 24 hours per
workspace + actor + route; expenses/tasks routes include the project id). Repeat the request with the same key after a timeout and you get the FIRST result back
instead of a duplicate record. A malformed or empty key is 400 invalid_idempotency_key; the same key while the first
request is still running is 409 idempotency_in_progress ("A request with this Idempotency-Key is still in progress");
the same key with a different body is 422 idempotency_key_reused ("Idempotency-Key reused with a different request"). Every 429 carries a Retry-After header (seconds): wait
that long. Rate buckets are per actor id (workspace ceiling 5x); failed bearer authentication is throttled at 20
per minute per client IP: once an address spends its budget it gets 429 with Retry-After (a VALID token is never throttled
by this). A PAT whose creator is now a viewer is read-only (403 forbidden_scope, "This token's creator now has read-only
access; the token is read-only"); approvals still need an admin/manager creator. A PAT stops working (401) when its creator's profile is removed. Audit rows now carry
principal_id (the person behind the actor).

Public routes (no Bearer token): /health, /api/openapi.json, /llms.txt, POST /auth/demo-login,
POST /auth/signout, POST /invites/accept, and GET /calendar/{token} (the secret in the URL is the credential).
Three more are authenticated by something other than a PAT: /integrations/lark/{connectorId}/events and
/card (signed by Lark/Feishu), /integrations/lark/{connectorId}/relay (HMAC from the self-host worker),
and GET /integrations/cron (Authorization: Bearer <CRON_SECRET>, the host scheduler only).

## Response shape
Success:   { "data": <object|array>, ["total": N, "page": N, "limit": N] }
Error:     { "error": "<message>", ["code": "<stable_code>"], ["fields": [{"field": "...", "message": "..."}]] }
Branch on code, not on the message: unauthorized, forbidden_scope, not_found, rule_violation, rate_limited,
precondition_failed, self_approval, no_principal, already_decided, project_locked,
rebaseline_not_pending, already_applied, change_request_decided,
children_changed, target_changed, bad_origin, invalid_reference, decision_in_use,
duplicate_deletion_request, has_timesheet_records, not_requester, app_id_immutable.
Newer codes: version_required, rationale_required, project_has_approved_records, change_request_required,
change_request_invalid, change_request_not_approved, decision_accepted_locked, supersede_loop, author_cannot_approve,
approve_after_edit, duplicate_clash, unfinished_tasks, invalid_destination, open_tasks, admin_created, not_expired,
last_admin, member_removed, member_not_removed, no_change, self_reset, unknown_provider, invalid_key, key_unverified,
agents_cannot_unlock, connector_not_active, delivery_not_dead, delivery_already_queued.

## Common-pattern rules (owner decisions 19-25, 2026-10-18)
- Unknown body fields are refused 422 ("Unknown field x. Nothing was saved.") on projects, tasks, milestones, risks,
  issues, sprints, clashes, allocations, resources and programs.
- Budget: GET returns overspend { level ok|warn|over, warn_pct (default 90), over_pct (100), events[] }; set
  overspend_warn_pct (1-100) on PUT/PATCH. Warns, never blocks. On a LOCKED project a budget change needs
  change_request_id of an APPROVED change request.
- A project with approved change requests or approved/applied rebaselines cannot be deleted (422 project_has_approved_records).
- Change requests: approve and reject REQUIRE expected_updated_at (422 version_required, 412 if it changed); reject and
  defer need a rationale. A deferred request is parked: POST /change-requests/{id}/reopen returns it to under_review.
- Decisions and documents are tier B: only a manager or admin marks a decision accepted or approves a document, and a
  document's author cannot approve it. Accepted decisions cannot be edited or deleted; supersede them instead.
- Tokens: expires_at defaults to now + 90 days (max 365); GET /tokens adds days_left and expiring_soon. Two-step is
  required for admins and managers after a 14-day grace (GET /auth/mfa shows required, in_grace, grace_days_left, must_enrol);
  tokens keep working. Session length is a Supabase dashboard setting.
- People: /members endpoints are admin or manager USER SESSIONS only; a token is refused.

Exception: the three /integrations/lark/{connectorId}/* routes answer in the PLATFORM's contract
(a challenge, {}, or { toast, card }), not the { data } envelope.

## References must stay inside your workspace
Any id in a request body that points at another record (owner_id, assignee_id, blocked_by, supersedes,
project_id, task_id, member_id, resource_member_id, project_a_id/project_b_id, profile_id) must belong to YOUR
workspace. Otherwise: 422, code invalid_reference, and "fields" names every offending field, e.g.
  { "error": "Referenced record not found in this workspace", "code": "invalid_reference",
    "fields": [{ "field": "owner_id", "message": "owner_id was not found in this workspace" }] }
A missing id and an id from another workspace give the SAME message (no existence oracle). null clears a
reference and is always allowed. A decision cannot supersede itself. A decision that another decision
supersedes cannot be deleted (422 decision_in_use).

## Raising a request needs a person too
Every route that RAISES a governed request — DELETE /tasks/{id}, DELETE /projects/{id}, POST
/projects/{id}/change-requests, POST /projects/{id}/rebaselines — answers 403,
code no_principal, to a token with no recorded owner (a requester with no person behind it is comparable to
nobody). Mint tokens from a signed-in session so they carry their creator.

HTTP status codes: 200 ok, 201 created, 202 accepted, 204 no content,
  400 bad request, 401 unauthenticated, 403 forbidden (scope or four-eyes), 404 not found, 422 rule/validation error,
  429 rate limited (baseline workspace+actor-class limit, fixed 60s window; retry after the interval
  named in the error message; code: rate_limited).

## Pagination
Lists accept ?limit (1..100, default 20) and ?page (1-based).
Response includes total, page, limit alongside data.

## Lean list payloads (R-129)
List endpoints for projects, tasks, milestones, risks and issues return a SUMMARY column set by default
(enough to scan and link: ids, names/titles, status, owner, dates, completion; no long text, no lock detail,
no source/external_ref columns). ?view=full returns every column. ?fields=a,b,c returns exactly those columns
(id is always included; a column outside the entity's allow-list is a 422). GET /<entity>/{id} always returns
the full record. Prefer the default, then fetch the one record you need in full.

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
             risk_category = technical | schedule | cost | resourcing | scope_requirements | supplier_external | regulatory_legal | organisational
             impact_areas = array of schedule | cost | scope | quality | reputation | compliance (impact_area = one-element shorthand; the legacy free-text category is no longer accepted)
             status = open | mitigating | closed | accepted (default open)
             raised_at / due_date = ISO 8601 datetime with offset.
Issues:      title, priority REQUIRED. priority = low | medium | high | urgent
             issue_category = technical_fault | resourcing | schedule_delay | cost_overrun | scope_change | organisational | supplier | external_event
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
             — never recomputed by a later task edit. POST /close takes an optional body
             { "move_unfinished_to": "backlog" | "<another planned/active sprint id of the same project>" }:
             when attached tasks are not finished and it is missing the close is refused 422
             unfinished_tasks (nothing changes) — ask the person, then resend with it.
Closing work:  PATCH /risks/{id} to status=closed needs a "resolution" note (same PATCH or already stored,
             up to 4000 chars); PATCH /issues/{id} to resolved|closed needs "resolution" too — else 422 with a
             field error on resolution. PATCH /milestones/{id} to status=completed while tasks are still open
             answers 422 open_tasks ("N tasks are still open. Complete this milestone anyway?"): resend with
             "confirm_open_tasks": true once the person agrees (a flag, never stored).
Task deletion: body { "reason": "<why>" } is REQUIRED (it becomes the audit trail).
Project deletion: body { "reason": "<why>" } is REQUIRED (it becomes the audit trail).
Project unlock: body { "reason": "<why>" } is REQUIRED (R-83 — lock's reason stays optional; unlock's is not).
Change requests: title REQUIRED on create. category = scope | schedule | cost | quality | resource | other (default scope);
             priority = low | medium | high | critical (default medium); status on create may ONLY be raised or
             under_review (default raised) — anything else is a 422; approved/rejected/deferred are reached only
             through the decision endpoint, which takes { "decision": "approve" | "reject" | "defer",
             "rationale": "...", "expected_updated_at"? } (rationale REQUIRED; expected_updated_at is the
             updated_at you were looking at — if the request was edited since, 412 instead of approving content
             you never saw). status is not updatable via PATCH, and neither PATCH nor DELETE works once the request
             is decided (422 change_request_decided).
Task dependencies: type = FS | SS | FF | SF (default FS), lag_days integer (default 0).

## Four-eyes compares PEOPLE, and only admins and managers approve
Every maker-checker flow (task/project deletion, change requests, rebaselines) is decided by a
DIFFERENT PERSON from the one who raised it. "Person" means the principal behind the caller: a signed-in user is
their own principal, an API token counts as the user who minted it, and a Lark card click counts as the NoPM
user the Lark account is linked to. So a requester cannot approve their own request with a token they created,
nor with a second token, however many identities they hold — 403, code self_approval. A token with no recorded
owner can never decide — 403, code no_principal. Wildcard scopes never grant the approve/decide scopes (above).
Who may approve (owner decision D-16, "follow Lark rules"): approving or deciding — deletion approve/reject,
change-request decide, rebaseline sign-off and apply — needs an admin or
manager HUMAN principal, on every channel. A member or viewer gets 403, code role_not_permitted, "Only managers
and admins can approve". A PAT that carries an approve scope inherits its CREATOR's CURRENT role: it can decide
while the person who minted it is an admin or manager, and stops the moment they are demoted (a member cannot
approve by minting a token). So an approve scope on a token is a manager's delegated authority; the four-eyes
rule still applies (a token never decides what its creator raised). Keep approve scopes off agent tokens unless
you mean it. Consequence for agents: an agent can raise requests and READ what is waiting (GET /review,
nopm review, MCP tool list_pending_approvals); the assistant's token never holds an approve/decide scope and
neither the assistant nor the MCP tool set has an approve/decide tool, so in practice a person decides, in the
console, on a Lark card, or over the REST API with their own credentials.
Hour logging and weekly timesheets were removed on 2026-10-17 (owner decision 18): no /time-entries or
/timesheet-submissions routes exist and no time:* scope is granted; a token that still carries one authenticates
normally and the retired scope is inert.

## Maker-checker: task and project deletion
DELETE /tasks/{id} and DELETE /projects/{id} do NOT immediately delete the target.
Task deletion requires scope task:delete:request; project deletion requires scope
project:delete:request. Both create a deletion_request with status=pending (target_type=task
or target_type=project) and return 202 Accepted. A DIFFERENT PERSON (approver != requester, by principal)
holding the scope matching the request's target_type must POST /deletion-requests/{id}/approve to
execute the deletion — task:delete:approve for task requests, project:delete:approve for
project requests (per-type gate; the route dispatches to the matching commit path). The approve body is
optional: { "note": "<why>" } (max 1000 chars) is recorded in the audit row of the decision.
Self-approval is rejected with 403 (code self_approval); self-rejection with 422 when the same actor, or 403
when the same person via another identity (four-eyes binds both decisions). A locked project is refused at
REQUEST time (422, code project_locked) for both task and project deletion, and again at approval as a backstop.
A project deletion request also records how many records of each kind hang off the project; if it gained any
before approval, the approval is refused (422 children_changed) — withdraw it and raise a new request.
A task deletion request records the task as it was; if the task is edited before approval, the approval is
refused (422 target_changed) for the same reason.
A checker cancels via POST /deletion-requests/{id}/reject; the ORIGINAL requester — or the person behind
the token or assistant that raised it — may cancel the pending request via
POST /deletion-requests/{id}/withdraw (per-type maker scope: task:delete:request or
project:delete:request).
Owner-locked (Decision 3, requirements/devops-wave1/README.md): maker-checker extends to
PROJECTS ONLY — milestones/risks/issues stay single-step hard deletes and never create a
deletion_request row.

## Optimistic concurrency (R-90)
PATCH /projects/{id}, /tasks/{id}, /milestones/{id}, /risks/{id}, and /issues/{id} accept an
OPTIONAL "expected_updated_at" field in the body (ISO 8601 datetime with offset — the same
format as the updated_at you last read on that record). Omit it and the PATCH behaves exactly
as it always has (last-write-wins). Send it and the server compares it against the row's
current updated_at before writing: a match proceeds normally; a mismatch is rejected with
412 (code: precondition_failed) instead of silently overwriting a change someone else already
made, and the response body includes current_updated_at so you can decide whether to reload
and retry or force the write by re-reading first. Best practice for any agent editing a record
across multiple turns: read the record, keep its updated_at, and pass it back as
expected_updated_at on the PATCH.

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

GET    /health                             — scope:none — liveness probe, public, DB-free. data = { status, service, time, build: { sha, ref } } — build says which commit is deployed (both null when the host exposes none), so "is live equal to main?" is answerable without a login
GET    /me                                 — scope:any  — resolve the current actor (type, id, workspaceId, scopes)
PATCH  /me                                 — user session only — update own profile
GET    /me/preferences                     — user session only — get DB-persisted display config (columns/groupBy per register, density, dateDisplay, defaultLanding) — L-39, unaudited (ADR 0009). Response includes demo (true for the shared demo login — treat as cookie-only, never write DB prefs for it).
PUT    /me/preferences                     — user session only — merge display config onto the existing stored config (not a verbatim replace). Body { config }; unknown keys stripped (not rejected); top-level keys in the body override, keys omitted from the body are preserved; columns/groupBy merge per register key; no way to delete a saved key. 10KB serialized-size cap checked against the merged result, 422 on an unrecognised value for a whitelisted key or over the size cap.

POST   /auth/demo-login                    — public — start a demo session. A browser navigation (Accept: text/html) that fails is redirected to /login?error=demo_unavailable|demo_unconfigured; programmatic callers keep JSON 503 when the demo is not configured and a 302 to /login?error=demo_unavailable when sign-in fails
POST   /auth/signout                       — user session — end the session
GET    /auth/mfa                           — user session — get MFA status: enabled, enrolled, satisfied (challenge passed this session)
POST   /auth/mfa/challenge                 — user session — verify TOTP or backup code after sign-in; sets the nopm_mfa cookie (10 attempts / 5 min per account, shared with verify and disable; 429 + Retry-After)
POST   /auth/mfa/enroll                    — user session — begin TOTP enrollment (returns secret + otpauth URI); 409 mfa_already_enabled "Two-step is already on. Turn it off first." when already on
POST   /auth/mfa/verify                    — user session — confirm TOTP code, enable MFA, receive backup codes (shown once)
POST   /auth/mfa/disable                   — user session — disable MFA; body { "code": "<current TOTP or unused backup code>" } is REQUIRED while on (422 when wrong or missing, audited auth.mfa.disable_failed); a TOTP code works once only; instead of { code } a two-step challenge passed in the last 10 minutes is accepted. Enroll, verify and disable answer 403 demo_restricted for the shared demo login; re-enrol over a live factor is also allowed within 10 minutes of a challenge

GET    /tokens                             — admin/manager session — list API tokens (token_hash never returned). Hides only the in-app assistant's per-turn ephemeral tokens, by their kind — never by name
POST   /tokens                             — admin/manager session — mint a new token (raw value returned once)
DELETE /tokens/{id}                        — admin/manager session — revoke a token
                                           A new token expires in 90 days unless expires_at is given; over 365 days or in the past is 422. GET /tokens adds days_left and expiring_soon (under 14 days).

GET    /members                            — admin/manager USER session (never a token) — list the people in the workspace, removed ones included
PATCH  /members/{id}                       — admin session — change a role { role }; codes last_admin, no_change, member_removed; audited member.role_change
DELETE /members/{id}                       — admin session, or a person leaving themselves — remove a member (leaver): login banned, tokens revoked, pending invites cancelled, history kept; 422 last_admin; audited member.remove
POST   /members/{id}/restore               — admin session — restore a removed member, body { role? }; 422 member_not_removed, role_escalation; audited member.restore
POST   /members/{id}/mfa-reset             — admin session — reset another person's two-step sign-in; returns fresh backup_codes ONCE; 422 self_reset; audited member.mfa_reset

GET    /workspace-settings                 — any caller — { time_zone, default_time_zone } (IANA; default Asia/Kuala_Lumpur; server today-defaults follow it)
PATCH  /workspace-settings                 — admin session — change { time_zone }; audited workspace.settings_update

GET    /invites                            — admin/manager session — list link invites (L-47/L-48). status is DERIVED (pending|accepted|revoked|expired), never a stored column. Optional ?status= filter.
POST   /invites                            — admin/manager session — create a link invite. Role-escalation cap (D5): invite.role must be <= the creator's own rank (viewer<member<manager<admin) — 422 if exceeded. Token prefix npi_. expires_at = now + 7 days. invite_url returned ONCE.
POST   /invites/{id}/revoke                — admin/manager session — revoke a pending invite (422 if not pending)
POST   /invites/{id}/renew                 — admin/manager session — renew an EXPIRED invite for another 7 days (422 not_expired otherwise; a manager cannot renew an admin-created invite: 403 admin_created; audited invite.renewed)
POST   /invites/accept                     — scope:none — public, unauthenticated. Provisions a brand-new login (createUser THEN the atomic nopm_accept_invite RPC — writes profiles + resource_members + marks the invite + 2 audit rows in one transaction). Body: { token, password (>=12 chars), display_name } — NO email field, the invite's own email is always used. Rate-limited 10/min per client network (the address your own proxy appended to X-Forwarded-For — on Vercel read from the platform; self-hosted, set NOPM_TRUSTED_PROXY_HOPS to your proxy count, else every caller shares one conservative bucket; this endpoint has no actor to key the baseline limiter on). No session is returned — sign in via /login afterwards. Anti-enumeration (T3, F2c-mini): not-found/already-used/revoked/expired ALL return the same uniform 422 (never a distinct 404) — the /invite/[token] page keeps distinct friendly copy, an intentional asymmetry.

GET    /projects                           — scope:project:read  — list projects in workspace. Filters: ?source, ?external_ref (complement seam, R-81 — both exact-match; NoPM is the governed record beside Jira/Slack/Teams, not a replacement for them). Lean by default: ?view=summary|full, ?fields=a,b,c (see "Lean list payloads").
POST   /projects                           — scope:project:write — create a project (never created locked: is_locked in the body is ignored; locking is POST /projects/{id}/lock)
GET    /projects/{id}                      — scope:project:read  — get a project
PATCH  /projects/{id}                      — scope:project:write — update a project. On a LOCKED project, changing start_date, target_date or either baseline_* date is 422 project_locked (name, owner, RAG, commentary stay editable); owner_id must be in this workspace
DELETE /projects/{id}                      — scope:project:delete:request — request project deletion (maker step, returns 202, creates deletion_request); 422 project_locked if the project is locked
POST   /projects/{id}/lock                 — scope:project:write — lock the project timeline (Gantt becomes read-only); baselines (milestones, tasks and the project's own baseline dates, null-only) are snapshotted first, then the project is locked; the project row records locked_by_actor_type/locked_by_actor_id/locked_by_label (who really locked, incl. an agent token); the project.lock audit row carries after.project_baseline { before, after }
POST   /projects/{id}/unlock               — scope:project:write — unlock the project timeline; body { "reason": "<why>" } is REQUIRED (R-83 — recorded in the audit trail's after.unlock_reason, not stored on the row); unlocking also CANCELS the project's pending_approval and approved rebaselines atomically (status cancelled, terminal; after.cancelled_rebaselines lists their ids, each gets a rebaseline.cancelled audit row), so a sign-off can never be applied to dates edited after it — propose a new rebaseline after relocking

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
POST   /sprints/{id}/close                 — scope:sprint:write — governed active->closed transition (optional body move_unfinished_to = backlog | sprint id; 422 unfinished_tasks without it when tasks are unfinished); snapshots completed_points/completed_snapshot from attached tasks with status_type=completed, written once, never recomputed (L-18)
POST   /sprints/{id}/tasks                 — scope:sprint:write — attach a task to a sprint (task must be in this workspace AND the sprint's own project — 422 otherwise); 422 if sprint is closed
DELETE /sprints/{id}/tasks                 — scope:sprint:write — detach a task from a sprint. ?task_id=<uuid> REQUIRED. The task must currently be attached to THIS sprint (422 otherwise); 422 if sprint is closed

GET    /saved-views                        — scope:saved_view:read  — list saved views (own personal + all shared in workspace, never another identity's personal view — L-41). Optional ?register=tasks|risks|issues|clashes|...
POST   /saved-views                        — scope:saved_view:write — save the current filters+sort+columns+groupBy as a view (L-05). Token/agent callers are always forced to scope=shared (no owning identity for personal).
GET    /saved-views/{id}                   — scope:saved_view:read  — get a saved view (404, not 403, if it's personal and not yours)
PATCH  /saved-views/{id}                   — scope:saved_view:write — update/share/protect a saved view; owner or admin only (403 otherwise). A protected view 403s a config PATCH unless the same call also unprotects it (L-07). Scope/protected toggles are audited (L-06/L-07).
DELETE /saved-views/{id}                   — scope:saved_view:write — delete a saved view (plain hard delete, single-step, audited — NOT maker-checker)
POST   /saved-views/{id}/duplicate         — scope:saved_view:write — clone any visible view (incl. a protected one) into a fresh, unprotected personal copy owned by the caller — user sessions only

GET    /projects/{id}/milestones           — scope:milestone:read  — list milestones for a project. ?view=summary|full, ?fields=a,b,c
POST   /projects/{id}/milestones           — scope:milestone:write — create a milestone under a project
GET    /milestones/{id}                    — scope:milestone:read  — get a milestone
PATCH  /milestones/{id}                    — scope:milestone:write — update a milestone
DELETE /milestones/{id}                    — scope:milestone:write — delete a milestone

GET    /tasks                              — scope:task:read  — cross-project task list (L-04), workspace-scoped not per-project. Filters: project_id/assignee_id/status_type/priority/due_before/due_after/overdue/q/source/external_ref (source/external_ref: complement seam, R-81 — both exact-match). Sort (L-10): ?sort=field:asc|desc against due_date|priority|status_type|name|created_at|completion_pct — unknown field/direction 422s. ?view=summary|full, ?fields=a,b,c. Reused by GET /export?entity=tasks.
GET    /projects/{id}/tasks                — scope:task:read  — list tasks for a project. ?view=summary|full, ?fields=a,b,c
POST   /projects/{id}/tasks                — scope:task:write — create a task in a project
GET    /tasks/{id}                         — scope:task:read  — get a task
PATCH  /tasks/{id}                         — scope:task:write — update a task (Kanban moves are audited)
DELETE /tasks/{id}                         — scope:task:delete:request — request task deletion (maker step, returns 202, creates deletion_request)
GET    /tasks/{id}/dependencies            — scope:task:read  — list a task's predecessors
POST   /tasks/{id}/dependencies            — scope:task:write — add a dependency (predecessor_id, type FS|SS|FF|SF, lag_days)
DELETE /tasks/{id}/dependencies            — scope:task:write — remove a dependency (predecessor_id in body)

GET    /projects/{id}/risks                — scope:risk:read  — list risks for a project. Filters: ?source, ?external_ref (complement seam, R-81 — both exact-match), ?impact_area=cost,schedule (any-of). ?view=summary|full, ?fields=a,b,c. Risks carry risk_category (enum) and impact_areas (array); the legacy free-text category is gone.
POST   /projects/{id}/risks                — scope:risk:write — create a risk under a project
GET    /risks/{id}                         — scope:risk:read  — get a risk
PATCH  /risks/{id}                         — scope:risk:write — update a risk
DELETE /risks/{id}                         — scope:risk:delete — delete a risk

GET    /projects/{id}/issues               — scope:issue:read  — list issues for a project. Filters: ?source, ?external_ref (complement seam, R-81 — both exact-match). ?view=summary|full, ?fields=a,b,c.
POST   /projects/{id}/issues               — scope:issue:write — create an issue under a project
GET    /issues/{id}                        — scope:issue:read  — get an issue
PATCH  /issues/{id}                        — scope:issue:write — update an issue
DELETE /issues/{id}                        — scope:issue:delete — delete an issue

GET    /clashes                            — scope:clash:read  — list clashes (schedule/resource/dependency conflicts, cross-project)
POST   /clashes                            — scope:clash:write — create a clash record
GET    /clashes/{id}                       — scope:clash:read  — get a clash
PATCH  /clashes/{id}                       — scope:clash:write — update a clash
DELETE /clashes/{id}                       — scope:clash:write — delete a clash

GET    /resources                          — scope:resource:read  — list resource members (people with cost rates and capacity)
POST   /resources                          — scope:resource:write — create a resource member
GET    /resources/{id}                     — scope:resource:read  — get a resource member
PATCH  /resources/{id}                     — scope:resource:write — update a resource member
DELETE /resources/{id}                     — scope:resource:write — delete a resource member; 422 has_timesheet_records if the member has any retained timesheet submission (history kept after decision 18) (their approval history would be erased)

GET    /allocations                        — scope:resource:read  — list allocations
POST   /allocations                        — scope:resource:write — create an allocation (triggers over-allocation clash detection)
GET    /allocations/{id}                   — scope:resource:read  — get an allocation
PATCH  /allocations/{id}                   — scope:resource:write — update an allocation (re-runs clash detection)
DELETE /allocations/{id}                   — scope:resource:write — delete an allocation

GET    /projects/{id}/budget               — scope:budget:read  — get budget summary (planned, committed, actual = expenses only, variance, burn_pct)
PUT    /projects/{id}/budget               — scope:budget:write — set the project budget: planned_amount required, committed_amount / currency default to 0 / USD when omitted; actual_amount, contingency_reserve, management_reserve are stored when sent
PATCH  /projects/{id}/budget               — scope:budget:write — PARTIAL update: only the fields in the body are written (nothing is defaulted); 422 on an empty body
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
DELETE /decisions/{id}                     — scope:decision:write — delete a decision (422 decision_in_use if another decision supersedes it)

GET    /projects/{id}/change-requests      — scope:change:read  — list change requests for a project
POST   /projects/{id}/change-requests      — scope:change:write — raise a change request. Only title is required; status may only be raised|under_review (default raised) — any other value is a 422, never a raw database error
GET    /change-requests/{id}               — scope:change:read  — get a change request
PATCH  /change-requests/{id}               — scope:change:write — update a change request (status is NOT updatable here); only while raised/under_review (422 change_request_decided once decided) and only by the requester's person - the user who raised it or a token that user minted (403 not_requester for anyone else, 403 no_principal for an ownerless token). Editing what an approver decides on retires any approval card already sent and issues a fresh one
DELETE /change-requests/{id}               — scope:change:write — delete a change request; only while raised/under_review (422 change_request_decided once decided) and only by the requester's person (403 not_requester otherwise); the approval cards already sent for it are closed
POST   /change-requests/{id}/decision      — scope:change:decide — decide a change request (admins and managers only — 403 role_not_permitted; approve | reject | defer + rationale, audited); the decider must be a different PERSON from the requester (principal compare plus the legacy actor checks) — 403 self_approval otherwise, 403 no_principal for a token with no recorded owner; the update is a compare-and-set, so a request already decided (or lost to a racing decider) is 422 already_decided
POST   /change-requests/{id}/review        — scope:change:decide — start review: raised -> under_review (admins and managers only; audited change_request.start_review)
POST   /change-requests/{id}/reopen        — scope:change:write — reopen a DEFERRED change request to under_review (the requester or an admin/manager; a deferral is parked, not final; audited change_request.reopen)

GET    /projects/{id}/rebaselines          — scope:project:read  — list rebaseline records for a project
POST   /projects/{id}/rebaselines          — scope:project:write — propose a rebaseline (reason required); 403 no_principal for a token with no recorded owner; 409 pending_rebaseline_exists ("This project already has a rebaseline waiting for sign-off") when one is already awaiting sign-off; 409 rebaseline_version_conflict ("Another rebaseline proposal was created at the same moment. Reload and try again.") when two proposals race (distinct from pending_rebaseline_exists). Lifecycle: draft -> pending_approval -> approved -> applied, or pending_approval -> rejected, or pending_approval / approved -> cancelled when the project is unlocked (applied, rejected and cancelled are terminal)
POST   /rebaselines/{id}/signoff           — scope:rebaseline:approve — sign off a rebaseline (admins and managers only — 403 role_not_permitted; four-eyes by PERSON: vote { "go" | "no_go", comment? }; a token votes as the user who minted it; 403 self_approval / no_principal). Only while pending_approval — otherwise 422 rebaseline_not_pending (a rejected one cannot be revived, an applied one cannot regress)
POST   /rebaselines/{id}/apply             — scope:rebaseline:approve — apply an approved rebaseline (admins and managers only — 403 role_not_permitted; 422 project_not_locked "Rebaseline cannot be applied: its project is no longer locked. Lock the project and propose a new rebaseline." when the project was unlocked meanwhile): milestone, task AND project baseline dates become the current plan, and the rebaseline.apply audit row carries after.project_baseline { before, after } so History and the Trust Center show the project baseline moving (the requester cannot apply their own — 403 self_approval; 422 already_applied if it was applied already, 422 rule_violation if it is not approved)
POST   /rebaselines/{id}/withdraw          — scope:project:write — the proposer withdraws a rebaseline that is still pending_approval (403 not_requester for anyone else; 422 rebaseline_not_pending); becomes cancelled, audited rebaseline.withdrawn

GET    /review                             — scope:task:read or audit:read or change:read or project:read — "what is waiting for a human?": every governed decision pending in the workspace, oldest first, across deletion requests (task + project), change requests (raised/under_review) and rebaselines awaiting sign-off. READ-ONLY. ?kind=task_deletion|project_deletion|change_request|rebaseline (comma list or repeated), ?page, ?limit (1..200, default 50). Response { data: [{ kind, id, title, summary, project_id, project_name, requested_by_label, requested_at, can_decide, reason_if_not }], total, page, limit, hidden_kinds }. can_decide = holds the decide scope AND is a different person from the requester; reason_if_not says why not. Kinds the token cannot read are named in hidden_kinds (an empty list is NOT proof nothing is pending); a token that can read none gets 403.

GET    /deletion-requests                  — scope:task:read or audit:read — list deletion requests (?status=pending|approved|rejected|committed|withdrawn; target_type=task|project)
POST   /deletion-requests/{id}/approve     — scope:<type>:delete:approve — approve and execute a pending deletion (admins and managers only — 403 role_not_permitted; per-type gate: task:delete:approve or project:delete:approve; four-eyes by PERSON: approver != requester — 403 self_approval, 403 no_principal; 422 already_decided). Optional body { "note": "<why>" } is recorded in the audit row.
POST   /deletion-requests/{id}/reject      — scope:<type>:delete:approve — reject a pending deletion request (admins and managers only — 403 role_not_permitted; per-type gate; four-eyes: no self-rejection — 422 for the same actor, 403 for the same person via another identity; optional body { "reason" })
POST   /deletion-requests/{id}/withdraw    — scope:task:delete:request or project:delete:request — withdraw your OWN pending deletion request (maker step; per-type scope matching the request's target)

GET    /notifications                      — scope:notification:read — list in-app notifications for the actor
PATCH  /notifications/{id}                 — scope:notification:read — mark a notification read/unread
POST   /notifications/read-all             — scope:notification:read — mark all notifications read

GET    /audit                              — scope:audit:read — query immutable audit log (?target_type, ?target_id, ?action, ?actor_id, ?channel one of ui|api|cli|mcp|assistant|lark — R-82, unrecognized values ignored; ?since ISO 8601 timestamp — 422 if unparsable, ?after_id uuid of a row already seen — 404 if absent from this workspace, ?order asc|desc default desc — 422 otherwise; since/after_id combine — R-85). Each row carries channel (declared/caller-asserted client, NOT an authorization input) and request_id (per-request correlation id, also echoed as the X-Request-Id response header) — both nullable for rows predating migration 20260906000042_audit_channel.sql. A decision made from a Lark card is recorded with channel=lark plus via_connector_id / external_event_id / external_actor_ref (platform ids abbreviated; server-derived, never taken from X-NoPM-Client — a caller can only declare ui|api|cli|mcp|assistant); ?channel=lark filters to them. Connector audit rows carry the Lark app id, chat id and platform ids abbreviated (the stream is member-readable).
GET    /search                            — scope:project:read — full-workspace search (?q=) across projects, tasks, programs, sprints, risks, issues, clashes, documents, change requests, decisions
GET    /timeline                           — scope:project:read — the Mainline portfolio graph (every artifact + task-dependency DAG in one governed read)
GET    /metrics/time-in-status             — scope:task:read — per-task status-span history (?task_id, ?project_id, ?date_from/?date_to entered_at window, ?limit)

GET    /export                             — scope:<entity>:read — governed CSV export (L-27/L-36). ?entity=tasks|risks|issues|clashes|audit|programs|projects|members|tokens|identities (required; members/tokens/identities = access review, admin or manager SESSION only, 403 for any token; tokens never export the hash). from/to (UTC days, inclusive) and on=created|updated apply to EVERY entity. risks also take impact_area=a,b (any-of) and export risk_category + impact_areas. Reuses the SAME filter/sort params as each entity's list API (tasks: project_id/assignee_id/status_type/priority/due_before/due_after/overdue/q/sort; risks/issues: project_id OPTIONAL (omitted = whole workspace) + status/severity(/priority for issues)/q/sort; projects: rag_status/phase/program_id/q/sort; clashes: none; audit: target_type/target_id/action/actor_id/channel (R-82)/since/order (R-85, lenient — bad value dropped, not 422; after_id NOT supported here); programs: none, fixed name asc). Streams text/csv, filename nopm-<entity>-<date>.csv (server-derived date). entity=audit CSV columns include channel, request_id, principal_id, principal_label, via_connector_id, external_event_id and external_actor_ref. Capped at 10,000 rows (truncation noted in a final CSV row + server log). Writes one audit_log row per export (action export.csv, target_type=entity) — exporting the audit log is itself audited.

GET    /reports/deck                       — scope:audit:read AND budget:read (both required — the deck carries budget figures) — portfolio deck (?format=pptx|pdf|html)
POST   /reports/deck                       — scope:audit:read AND budget:read (both required) — portfolio deck (POST variant)
GET    /reports/project/{id}               — scope:audit:read AND budget:read (both required — the report carries budget figures) — single-project report (?format=pptx|pdf|html)
POST   /reports/project/{id}               — scope:audit:read AND budget:read (both required) — single-project report (POST variant)

POST   /assistant/chat                     — user session only — BYOK governed assistant turn (SSE or JSON)
GET    /assistant/conversations            — user session only — list saved assistant conversations
GET    /assistant/conversations/{id}       — user session only — get one conversation
GET    /assistant/credentials              — user session only — check stored provider credential status (never returns the key)
PUT    /assistant/credentials              — user session only — store a provider API key (AES-256-GCM at rest)
DELETE /assistant/credentials              — user session only — remove the stored key

GET    /api/openapi.json                   — scope:none — OpenAPI 3.1 spec for this API (public)

GET    /calendar-feeds                     — scope:milestone:read — list YOUR active milestone calendar feeds (the subscription URL is never returned here)
POST   /calendar-feeds                     — scope:milestone:write — create a feed; body { name, project_id? } (project_id omitted = whole workspace). Returns the feed plus url (…/api/calendar/npc_<secret>.ics) ONCE — the URL is the credential. A token owns the feed as the user who minted it; a token with no recorded owner is 403.
DELETE /calendar-feeds/{id}                — scope:milestone:write — revoke a feed (its owner or a workspace admin; the URL stops working at once; 422 already_revoked if repeated)
GET    /calendar/{token}                   — scope:none — PUBLIC (the secret in the URL is the credential): the feed as text/calendar, one all-day event per milestone with a target date. token = npc_… with an optional .ics suffix. Window: milestones from 90 days ago onward, in date order, at most 2000 events (header X-NoPM-Feed-Truncated: 1 when the cap cut the far end). Strong ETag: send it back as If-None-Match and an unchanged feed is a body-less 304. Throttled: 429 + Retry-After (120/min per client address where one can be trusted - on Vercel, or behind NOPM_TRUSTED_PROXY_HOPS proxies - and 60/min per feed). Unknown, malformed and revoked tokens all get the same 404.

GET    /integrations/connectors            — signed-in user session — list the workspace's chat connectors. Admin: full masked view (presence flags, config, callback_urls, revoked history, and a health block { pending, retry, dead, last_sent_at, last_error, last_cron_at, last_cron } — never a secret). Any other member: a redacted view of live connectors only (id, name, kind, status, region, mode, approvals.enabled, digest.enabled).
POST   /integrations/connectors            — admin session — connect a Lark/Feishu app (one live connector per workspace; 422 connector_exists). encrypt_key is REQUIRED in webhook mode (422 on fields[encrypt_key]); long_connection may omit it. Credentials are encrypted at rest and never returned; the relay_secret for the self-host worker is returned ONCE.
PATCH  /integrations/connectors/{id}       — admin session — rename, pause/resume (status active|paused — the kill switch for both directions), change config, replace credentials (write-only), clear_tenant_pin (the admin view reports tenant_pinned: true once the first admin/manager account link locks the connector to that Lark tenant; clearing lets the next such link re-pin it), or rotate_relay_secret (returned once). A webhook connector must still hold an encrypt_key after any update that touches the mode or credentials (422 on fields[encrypt_key]); a pause or rename is never held up by it. The app id cannot be changed (422 app_id_immutable): revoke the connector and create a new one for a different app
DELETE /integrations/connectors/{id}       — admin session — revoke the connector (irreversible; unlinks every account, supersedes queued deliveries)
POST   /integrations/connectors/{id}/test  — admin session — check the stored credentials against the platform; always 200 with data.ok true|false; not audited (read-style)
POST   /integrations/connectors/{id}/digest — admin session — send the workspace digest to the configured group chat now (audited integration.digest.send); data = { delivery_id, status }
GET    /integrations/connectors/{id}/deliveries — admin session — failed or retrying chat messages, ?status=dead|retry (default dead), newest 50
POST   /integrations/connectors/{id}/deliveries/{deliveryId}/retry — admin session — retry one dead message; 422 connector_not_active, delivery_not_dead, delivery_already_queued; audited integration.delivery.retry
GET    /integrations/identities            — signed-in user session — linked platform accounts: your own, or every member's for an admin (?mine=1 for just yours); platform ids masked
POST   /integrations/identities/link-code  — signed-in user session — mint a one-time NPL-XXXX-XXXX code (10 minutes, single use); DM "link <code>" to the bot to bind that Lark account to YOU (never by email)
DELETE /integrations/identities/{id}       — signed-in user session — unlink a platform account (your own, or any for an admin)
GET    /integrations/cron                  — Bearer CRON_SECRET (NOT a PAT; host scheduler only) — daily tick (01:07 UTC): retry due deliveries, send each connector's weekly digest on its weekday (a missed weekday is made up by a later tick in the same ISO week, unless the connector was edited after that day began), prune old bookkeeping rows; idempotent. Only the FLOOR of the retry ladder (1 m, 5 m, 30 m, 2 h, 12 h, then dead) — due retries also drain whenever the workspace has approval traffic. Stops starting work at 40 s of its 60 s budget; the rest stays queued. Summary: { connectors, deliveries, digests, skippedForDeadline, timedOut, pruned, elapsedMs }
POST   /integrations/lark/{connectorId}/events — public, signed by Lark/Feishu (verification token, plus Encrypt Key signature when set) — event subscription endpoint: url_verification handshake, bot DM commands (help, link <code>, approvals). Answers in the platform's contract, NOT { data }: { challenge }, {} or { toast, card }. One generic 401 { error: "Invalid request" } for any verification failure AND for an unknown, paused or revoked connector (404 only for a malformed id); 503 if the active connector cannot decrypt its own secrets; failed verifications are capped per connector and per client network (429).
POST   /integrations/lark/{connectorId}/card — public, signed by Lark/Feishu — card.action.trigger callback: the Approve / Reject button click. Replies 200 { toast, card? } within 3 s; a refused click (unlinked, expired, not the recipient, self-approval, already decided, or "changed" — the request was edited after the card was sent, so nothing was decided and a fresh card follows) is a toast, not an HTTP error.
POST   /integrations/lark/{connectorId}/relay — public, HMAC-signed by the self-host worker (headers X-NoPM-Relay-Timestamp, X-NoPM-Relay-Signature: v1=hex(HMAC-SHA256 over "<timestamp>.<raw body>", key = the 64-char hex text of SHA-256(relay secret)), within ±300 s) — body { type: ping | event | card, payload }. Same governed path as the webhooks. An unknown connector id is the same 401 invalid_relay_signature as a wrong signature; 404 only for a malformed id; 403 connector_inactive / wrong_mode only to an authenticated caller; 503 connector_unavailable if its secrets cannot be decrypted. The pre-auth per-network cap keys on the address your own proxy appended to X-Forwarded-For (self-host: set NOPM_TRUSTED_PROXY_HOPS).

POST   /mcp                                — scope: your own PAT (Bearer) — remote MCP server (Streamable HTTP, stateless JSON-RPC); every tool call is forwarded to this API with YOUR token, so scopes, audit and maker-checker apply unchanged. No Bearer header = 401 { error, code: "unauthorized" } with WWW-Authenticate: Bearer realm="nopm".
GET    /mcp                                — scope: your own PAT (Bearer) — Streamable HTTP event-stream verb handled by the MCP SDK (stateless server; clients use POST)
DELETE /mcp                                — scope: your own PAT (Bearer) — Streamable HTTP session-termination verb handled by the MCP SDK (there are no sessions to end)

---

## Integrations (Lark / Feishu)

An admin connects ONE Lark or Feishu self-built app per workspace (POST /integrations/connectors). Then:
- Each member links their own Lark account: POST /integrations/identities/link-code returns NPL-XXXX-XXXX;
  they DM "link <code>" to the bot. The bot event carries the platform-verified user id, so the link is proven,
  never guessed from an email address. One active link per member per connector.
- When a deletion request or change request is raised, every eligible approver (admin or
  manager, linked, and not the requester's person) gets a card with Approve / Reject buttons (Reject needs a
  reason). A click runs the SAME governed decision as the console: per-type scope, four-eyes by person, locks,
  exactly one audit row, with channel=lark and the connector / platform event ids recorded. The card is
  single-use, bound to its recipient, and updates in place when the request is decided from ANY channel.
- A card shows the request as it was when sent. If a pending change request is edited, the old card is retired
  and a fresh one with the current content is issued; a tap on a stale card decides NOTHING (a "changed" toast),
  and the decision write is pinned to the version the card showed. One approver gets at most 20 cards an hour;
  past that, one "N approvals are waiting" roll-up message replaces further cards.
- Linking: a code never moves an existing link. If you are already linked to another Lark account the bot
  refuses ("This NoPM account is already linked to another Lark account. Unlink it in NoPM (Integrations) first,
  then send a new code."), spends the code and audits integration.identity.link.blocked. Only a link made by an admin or manager pins the connector to its Lark tenant; failed link
  attempts are rate-limited (8 per Lark account, 120 per connector, per 10 minutes).
- A weekly digest goes to a configured group chat (and can be sent now); the bot also answers the DM commands
  help, link <code> and approvals.
Webhook mode REQUIRES an Encrypt Key (events are then signed and encrypted); long-connection mode does not.
Admins see delivery health (pending / retry / dead counts, last send, last error, last scheduler run) on
GET /integrations/connectors.
APPROVALS NEED A HUMAN ADMIN OR MANAGER. The integration adds a channel for humans, not for agents: an agent
token cannot click a card, and the assistant holds no approve/decide scope. Only an admin or manager can approve
or reject from chat (members are told "Only managers and admins can approve or reject from chat."), and the same
role rule applies on every other channel. Four-eyes compares PEOPLE (a token counts as
the user who minted it; a Lark click counts as the linked user), so a requester can never approve their own
request by another route, and wildcard scopes never grant approve/decide. What an agent CAN do is read what is
waiting: GET /review, "nopm review", or the MCP tool list_pending_approvals (it reports can_decide per item,
and why not), then tell the human it needs their decision.
Hosted deployments receive Lark's calls on /integrations/lark/{connectorId}/events and /card (mode webhook);
a self-hosted NoPM with no public URL runs web/scripts/lark-worker.mjs, which holds an outbound long connection
to Lark and relays each event to /relay (mode long_connection). Credentials are encrypted at rest and never
returned; paused or revoked connectors stop both directions.

## Calendar feed

POST /calendar-feeds returns a private subscription URL (…/api/calendar/npc_<secret>.ics) ONCE. Paste it into
Apple Calendar, Outlook, Google Calendar or a Lark calendar to see milestone target dates as all-day events
(whole workspace, or one project). It is read-only and revocable (DELETE /calendar-feeds/{id}); anyone holding
the URL can read the feed, so treat it as a secret. Calendar apps refresh it every few minutes to hours — the
response is cached for 15 minutes, carries a strong ETag (send If-None-Match to get a body-less 304 when nothing
changed) and is throttled (429 + Retry-After). The feed covers milestones from 90 days ago to the end of the
schedule, at most 2000 events; if the cap cuts the far end the response carries X-NoPM-Feed-Truncated: 1.
Renaming a project refreshes its events in subscribed calendars.

## Health and build

GET /health is public and database-free; data.build = { sha, ref } names the deployed commit (null when the host
exposes none), so an agent can check "is live equal to main?" before trusting a behaviour described here.

---

## MCP server

NoPM ships a native Model Context Protocol (MCP) server at web/mcp/server.mjs.
It exposes ${TOOL_REGISTRY.length} governed tools (list/get/create/update across the core modules, plus
workspace search, budget, clashes, resources, the audit log, and list_pending_approvals) over STDIO so any
MCP client (Claude Desktop, Claude Code, Cursor, etc.) can drive NoPM as an agent. The same tools are served
remotely at POST /mcp (Streamable HTTP) with your own PAT in the Authorization header.
list_pending_approvals is read-only (it calls GET /review): it answers "what is waiting for a human?" and reports
can_decide / reason_if_not per item, but there is deliberately no approve or decide tool.
The stdio server (web/mcp/server.mjs) can also raise a change request (create_change_request), propose a rebaseline
(propose_rebaseline), sign one off or apply it (sign_off_rebaseline, apply_rebaseline — these call the approve
routes with YOUR token, so they only work when the PAT holds rebaseline:approve and its creator is currently an
admin or manager; otherwise they return the API's 403 verbatim), and create a decision (create_decision) or a document record (create_document).
Tool schemas are generated from the same registry the in-app assistant uses and are
lock-tested against the API's Zod validators. Capabilities are bounded by the PAT
scopes; all writes are audited; task and project deletion both go through maker-checker
(the assistant can only request deletion and has no approve tool; an MCP token can approve only through the
rebaseline tools above, and only when its creator is an admin or manager).
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

2. Checker step — a DIFFERENT PERSON (a token counts as the human who created it) with the scope matching the request's
                  target_type (task:delete:approve or project:delete:approve) calls
                  POST /deletion-requests/{id}/approve
                  The API enforces approver != requester (403 on self-approval).
                  The route dispatches by the request's target_type to the matching
                  atomic commit RPC (nopm_commit_task_deletion / nopm_commit_project_deletion).
                  On success the target is deleted, the deletion_request moves to
                  status=committed, and two audit_log rows are written:
                  task.delete or project.delete, and deletion_request.approved.
                  Project deletions also 422 as PROJECT_LOCKED if the project's schedule
                  was frozen after the deletion was requested (a locked project is also
                  refused at request time).

To cancel instead: a DIFFERENT checker POSTs /deletion-requests/{id}/reject (self-rejection
is 422), or the original requester (or the person behind the token that raised it) POSTs /deletion-requests/{id}/withdraw (their one
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

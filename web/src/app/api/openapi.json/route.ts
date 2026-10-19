import { route } from "@/lib/api/handler";
import { z } from "zod";
import { createProjectSchema, updateProjectSchema, ProjectDeleteRequestSchema } from "@/app/api/projects/_schema";
import { createProgramSchema, updateProgramSchema } from "@/app/api/programs/_schema";
import { createSprintSchema, updateSprintSchema, sprintTaskAttachSchema, closeSprintSchema } from "@/app/api/sprints/_schema";
import { createInviteSchema, acceptInviteSchema } from "@/app/api/invites/_schema";
import { createMilestoneSchema, updateMilestoneSchema } from "@/app/api/milestones/_schema";
import {
  TaskCreateSchema,
  TaskUpdateSchema,
  TaskDeleteRequestSchema,
} from "@/app/api/tasks/_schema";
import { createRiskSchema, updateRiskSchema } from "@/app/api/risks/_schema";
import { createIssueSchema, updateIssueSchema } from "@/app/api/issues/_schema";
import { createSavedViewSchema, updateSavedViewSchema } from "@/app/api/saved-views/_schema";
import { putPreferencesBodySchema } from "@/app/api/me/preferences/_schema";
import {
  createChangeRequestSchema,
  updateChangeRequestSchema,
  decisionActionSchema,
} from "@/app/api/change-requests/_schema";
import { signoffSchema } from "@/app/api/rebaselines/_schema";
import { createCalendarFeedSchema } from "@/app/api/calendar-feeds/_schema";
import { createConnectorSchema, updateConnectorSchema } from "@/app/api/integrations/connectors/_schema";
import { PENDING_KINDS, DEFAULT_LIMIT as REVIEW_DEFAULT_LIMIT, MAX_LIMIT as REVIEW_MAX_LIMIT } from "@/lib/review/pending";
// The single tool registry shared with the stdio MCP server and the in-app assistant.
import { TOOL_REGISTRY } from "../../../../mcp/tools.mjs";

export const runtime = "nodejs";

/**
 * Request bodies for the core governed entities are GENERATED from the same
 * Zod validators the endpoints run — the spec cannot drift from what the API
 * actually accepts. (tools-zod.test.ts locks the agent tool registry to the
 * same validators.)
 */
function zodBody(schema: z.ZodType, required = true) {
  const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  delete jsonSchema.$schema; // meta-keyword noise inside an OpenAPI document
  return { required, content: { "application/json": { schema: jsonSchema } } };
}

const connectorIdParam = { name: "connectorId", in: "path", required: true, schema: { type: "string", format: "uuid" }, description: "The integration connector's id (it is part of the callback URLs shown to the admin)" };

/** Headers Lark / Feishu adds to a webhook when the connector has an Encrypt Key. */
const larkSignatureHeaders = [
  { name: "X-Lark-Request-Timestamp", in: "header", required: false, schema: { type: "string" }, description: "Epoch seconds; must be within +/-5 minutes. Sent (with the nonce and signature) when the connector has an Encrypt Key." },
  { name: "X-Lark-Request-Nonce", in: "header", required: false, schema: { type: "string" } },
  { name: "X-Lark-Signature", in: "header", required: false, schema: { type: "string" }, description: "Lowercase-hex SHA-256 of timestamp + nonce + EncryptKey + raw body. Once an Encrypt Key is set it is required on every request except the one-off url_verification handshake." },
];

// Lean list payloads (A7/K5, R-129) - allow-lists live in src/lib/api/views.ts.
const listViewParams = [
  {
    name: "view",
    in: "query",
    schema: { type: "string", enum: ["summary", "full"], default: "summary" },
    description:
      "Payload size. summary (default) returns the columns needed to scan and link; full returns every column including long text. GET /<entity>/{id} always returns the full record.",
  },
  {
    name: "fields",
    in: "query",
    schema: { type: "string" },
    description:
      "Comma-separated column list (e.g. id,name,rag_status). Overrides view; id is always included; a column outside the entity's allow-list is a 422.",
  },
];

const spec = {
  openapi: "3.1.0",
  info: {
    title: "NoPM API",
    version: "0.1.0",
    description:
      "API-first project-management tool designed to be driven by AI agents. " +
      "All mutations produce an immutable audit_log entry. " +
      "Task deletion is maker-checker: DELETE /tasks/{id} creates a deletion_request; " +
      "a different PERSON holding scope task:delete:approve must POST /deletion-requests/{id}/approve. " +
      "Project deletion is maker-checker too: DELETE /projects/{id} creates a deletion_request the same way. " +
      "DELETION BY REQUEST (wave 4, audit gap G8): DELETE on milestones, risks, issues, expenses and documents " +
      "is also a request, never a direct delete. Each needs its own scope (milestone:delete:request, risk:delete:request, " +
      "issue:delete:request, expense:delete:request, document:delete:request), requires a reason, answers 202 with the " +
      "deletion_request, and is decided by a different person holding the matching <entity>:delete:approve scope. " +
      "The database also refuses a direct delete of these tables unless an approved request is committing it. " +
      "Every authenticated request is subject to a baseline workspace+actor-class rate limit " +
      "(fixed 60s window; defaults 600/min read, 120/min write) — see components.responses.RateLimited. " +
      "R-90: PATCH /projects/{id}, /tasks/{id}, /milestones/{id}, /risks/{id} and /issues/{id} accept " +
      "an optional expected_updated_at in the body for optimistic concurrency — omit it for today's " +
      "last-write-wins behavior, or send the value you last read to get a 412 (see " +
      "components.responses.PreconditionFailed) instead of silently overwriting a concurrent edit. " +
      "R-82: send X-NoPM-Client (ui|api|cli|mcp|assistant) to declare which surface made a call — " +
      "recorded on the audit row as channel, provenance only, never an authorization input; send " +
      "X-Request-Id to correlate a request with its audit row (request_id), echoed back as the " +
      "X-Request-Id response header (server-generated when omitted). " +
      "Four-eyes compares PEOPLE, not actor ids: a signed-in user is their own principal, an API " +
      "token counts as the user who minted it (api_tokens.created_by), and a chat-card click counts " +
      "as the NoPM user the platform account is linked to. A decider whose person equals the " +
      "requester's is refused (403, code self_approval) however many identities they hold; a token " +
      "with no recorded owner can never decide (403, code no_principal). The approve/decide scopes " +
      "(task:delete:approve, project:delete:approve, change:decide, rebaseline:approve) " +
      "are NEVER granted by a wildcard (* or task:*, project:*, ...): each must be granted by its exact " +
      "name. Approving or deciding (deletion approve/reject, change-request decide, rebaseline sign-off and apply) is for ADMINS and MANAGERS only, on every channel (owner decision D-16, " +
      "'follow Lark rules'): a member or viewer gets 403, code role_not_permitted, 'Only managers and admins can " +
      "approve'. WAVE 4 (G1, G2): the APPROVAL TIER sets the least role that may decide a request. By default a manager " +
      "decides routine and normal requests; an admin decides high_risk and strategic requests " +
      "(403 role_not_permitted, with a message that names the tier's role, such as 'Only admins can approve a high-risk request.'). An emergency change commits when it is raised and needs no decision. Workspace Settings can change the role per tier. " +
      "A token is judged by the CURRENT role of the person who minted it (api_tokens.created_by), so a " +
      "token carrying an approve scope can decide only while its creator is still an admin or manager, and stops " +
      "the moment they are demoted. Such a token acts with its creator's authority: keep approve scopes off " +
      "agent tokens unless that is intended; GET /review lists what is waiting for a decision. " +
      "Hour logging and weekly timesheets were removed on 2026-10-17 (owner decision 18): there is no /time-entries or " +
      "/timesheet-submissions endpoint and no time:* scope is granted any more; a token that still carries one authenticates " +
      "normally and the retired scope is inert. " +
      "Retries: POST /projects/{id}/expenses, POST /projects/{id}/tasks and POST /allocations " +
      "accept an Idempotency-Key header (1-200 chars of [A-Za-z0-9_.:-], remembered 24 h per workspace + actor + " +
      "route; the expenses and tasks routes include the project id); a retry with the same key returns the first result instead of creating a second record. " +
      "A malformed or empty Idempotency-Key header is 400 invalid_idempotency_key. The same key while the first request is still running is 409 idempotency_in_progress " +
      "('A request with this Idempotency-Key is still in progress'). The same key with a different body is 422 idempotency_key_reused " +
      "('Idempotency-Key reused with a different request'). Every 429 carries a Retry-After header (seconds). Rate buckets are per actor id " +
      "with a workspace ceiling of 5x; failed bearer authentication is throttled at 20/min per client IP before " +
      "any token lookup: once an address spends its failed-attempt budget it gets 429 with Retry-After, and a VALID token is never throttled by this. " +
      "A personal access token whose creator is now a viewer is read-only (403 forbidden_scope, 'This token's creator now has read-only access; the token is read-only'); approvals still need an admin or manager creator. " +
      "A personal access token stops authenticating (401) when its creator's profile is gone or " +
      "belongs to another workspace; calendar feeds are unaffected (owner decision 9). Audit rows expose " +
      "principal_id (the person behind the actor, nullable) and the channel is derived from the credential " +
      "(a session is ui; a token is never ui). " +
      "Error bodies carry a stable machine-readable `code` beside `error` (e.g. unauthorized, " +
      "forbidden_scope, not_found, rule_violation, rate_limited, self_approval, no_principal, " +
      "already_decided, project_locked, " +
      "rebaseline_not_pending, already_applied, change_request_decided, children_changed, target_changed, target_gone, " +
      "bad_origin, invalid_reference, decision_in_use, " +
      "duplicate_deletion_request, has_timesheet_records, role_not_permitted, " +
      "pending_rebaseline_exists, rebaseline_version_conflict, invalid_idempotency_key, idempotency_in_progress, idempotency_key_reused, forbidden_scope, project_not_locked, mfa_already_enabled, account_exists, already_revoked, " +
      "demo_restricted, demo_readonly, connector_paused, demo_quota_unavailable, misconfigured, version_required, rationale_required, " +
      "project_has_approved_records, change_request_required, change_request_invalid, change_request_not_approved, decision_accepted_locked, " +
      "supersede_loop, author_cannot_approve, approve_after_edit, duplicate_clash, unfinished_tasks, invalid_destination, open_tasks, " +
      "admin_created, not_expired, last_admin, member_removed, member_not_removed, no_change, self_reset, unknown_provider, invalid_key, " +
      "key_unverified, agents_cannot_unlock, connector_exists, encryption_unavailable, " +
      "invalid_assigned_approver, not_requester, verify_throttled) — branch on it, not on the message. " +
      "COMMON-PATTERN RULES (owner decisions 19-25, 2026-10-18): a PATCH/POST with a field the endpoint does not know is refused 422 " +
      "(Unknown field x. Nothing was saved.) on projects, tasks, milestones, risks, issues, sprints, clashes, allocations, resources " +
      "and programs. Budget GET returns overspend { level, warn_pct, over_pct, events[] } (warn at 90%, over at 100%, warn_pct settable " +
      "1-100 via overspend_warn_pct) and a budget change on a LOCKED project needs an approved change request (send change_request_id: " +
      "422 change_request_required | change_request_invalid | change_request_not_approved). Deleting a project is refused (422 " +
      "project_has_approved_records) while it has approved change requests or approved/applied rebaselines. A new personal access token " +
      "expires in 90 days unless you pass expires_at; more than 365 days or a past date is 422; GET /tokens adds days_left and " +
      "expiring_soon. Admins and managers must use two-step sign-in after a 14-day grace (GET /auth/mfa adds required, in_grace, " +
      "grace_ends_at, grace_days_left, must_enrol). Decisions and documents stay one-person records (tier B): only a manager or admin " +
      "marks a decision accepted or approves a document, and the document author cannot approve their own. A deferred change request " +
      "can be reopened (POST /change-requests/{id}/reopen). A change-request approve or reject now REQUIRES expected_updated_at " +
      "(422 version_required; 412 precondition_failed if it changed) and reject or defer require a rationale. " +
      "A browser-session (cookie) POST/PUT/PATCH/DELETE whose Origin header is another site is refused " +
      "(403, code bad_origin); Bearer-token requests are never origin-checked. A malformed id (not a UUID) in " +
      "a path is 404 not_found, and a malformed value in a query filter or body is 422 validation_failed. " +
      "A request raised by a token with no recorded owner is refused up front (403, code no_principal) on every " +
      "route that RAISES a governed request — task / project deletion, change request, " +
      "rebaseline proposal — not only on the deciding side, because a requester with no person behind it is " +
      "comparable to nobody. " +
      "Cross-tenant reference guard: any id in a request body that points at another record (owner_id, " +
      "assignee_id, blocked_by, supersedes, project_id, task_id, member_id, profile_id, ...) must belong to the " +
      "caller's workspace. Otherwise the call is refused with 422, code invalid_reference, and `fields` naming " +
      "every offending field; a missing id and an id from another workspace give the SAME message, so the " +
      "response is not an existence oracle. null clears a reference and is always allowed. " +
      "Integrations (Lark / Feishu): a workspace admin connects ONE app per workspace under " +
      "/integrations/connectors (webhook mode requires an Encrypt Key); approvers get a card with Approve / " +
      "Reject buttons, and every click runs the same governed decision as the console (one audit row, channel " +
      "`lark`). A card describes the request as it was when sent: if a pending change request is edited, the old " +
      "card is retired and a fresh one issued, and a tap on a stale card decides nothing (a `changed` toast). One " +
      "approver is sent at most 20 cards an hour; past that they get a single \"N approvals are waiting\" roll-up " +
      "message instead, so a flood of requests cannot bury a person in chat. The three " +
      "/integrations/lark/{connectorId}/* routes are called by the platform (or the self-host " +
      "relay worker), authenticate by signature rather than a NoPM token, and answer in the " +
      "PLATFORM's contract, not the { data } envelope. A read-only milestone calendar feed " +
      "(/calendar-feeds, /calendar/{token}) lets any calendar app subscribe. " +
      "WAVE 3 (2026-10-18). BACKUP OWNERS: projects, risks, issues accept backup_owner_id and tasks accept backup_assignee_id " +
      "(uuid or null; a person in this workspace, different from the owner or assignee; 422 invalid_reference or a field-named " +
      "validation error). GET /reports/handover lists open items whose single owner has no backup. APPROVER ASSIGNMENT: the raise " +
      "routes (change requests, rebaselines, task and project deletion requests) accept an optional assigned_approver_id (an admin " +
      "or manager other than the requester; 422 invalid_assigned_approver). Assignment is routing only and never changes can_decide. " +
      "GET /review?mine=1 narrows the queue to requests assigned to the caller's person. SCOPE report:read opens GET /reports/weekly " +
      "and GET /reports/handover (not privileged; report:* covers it). STALE NUDGES and the weekly report run in the scheduler tick; the nightly snapshot " +
      "runs at GET /cron/snapshots under CRON_SECRET (internal). TREND and CONTINGENCY are advisory: GET /projects/{id}/trend and " +
      "GET /projects/{id}/contingency suggest a RAG and never change a declared RAG. DEPENDENCIES: POST /projects/{id}/dependencies " +
      "declares that a project depends on another; refused with 422 self_dependency, circular_dependency or risk_not_in_projects, " +
      "and 409 duplicate_dependency for the same pair and kind. " +
      "WAVE 4 (2026-10-18). APPROVAL TIERS (audit gaps G1, G2, G7): a change request, a deletion request and a rebaseline each carry " +
      "`tier` (routine | normal | high_risk | strategic | emergency) and `approval_deadline_at`. POST /projects/{id}/change-requests " +
      "accepts `tier` (routine only with no cost and no schedule impact; strategic needs an admin) and the server can only RAISE it: " +
      "a cost at or over the workspace currency threshold (default 50,000) or a schedule impact over schedule_threshold_days (default 10) makes a normal request high_risk; the currency is a label only, so no cost is converted. A fallback approver (decision D7) lets a manager decide an admin-level request while the workspace has fewer than two admins. The policy is " +
      "`approval_policy` on GET and PATCH /workspace-settings (admin session): the decider role and turnaround hours per tier, the " +
      "threshold and currency (emergency_retro_hours is deprecated and has no effect). TIMERS AND AUTO-APPROVE (G3): the daily scheduler reminds approvers at half " +
      "the turnaround, escalates to admins past it, and never writes the request row. Routine auto-approve is OFF by default; an " +
      "admin may switch it on for the routine tier only, and it never applies to a request with a cost or a schedule impact. " +
      "EMERGENCY (G4, owner decision Q1): POST /projects/{id}/change-requests with `is_emergency: true` (a manager or admin) commits at once: " +
      "the request is stored as approved with tier emergency and is_emergency true. It needs no approver, no retro decision and has no approval deadline; " +
      "the audit rows are change_request.create and change_request.emergency_commit. retro_due_at, retro_decided_at and retro_outcome are deprecated history fields. " +
      "DELETION BY REQUEST (G8): risk, issue, expense, document and milestone deletions are requests, see the intro above; an approved " +
      "document is on the manager tier like any other document. An expense deletion at or above the workspace currency_threshold is high_risk and only an admin approves it (audited deletion_request.tier_raised). " +
      "ATOMIC AUDIT AND TAMPER EVIDENCE (M1): a mutation and its audit row succeed or fail together, and every audit row carries " +
      "prev_hash, row_hash and chain_seq. GET /audit/verify (admin or manager session) recomputes the per-workspace chain and " +
      "reports the first bad row. The hash chain proves rows were not edited or removed from the middle; keep head_hash outside the database to cover a database owner who recomputes the chain. " +
      "GITHUB WORK EVENTS (A1): an admin connects one GitHub repository webhook per workspace (POST /integrations/github/connector). " +
      "GitHub calls POST /integrations/github/{connectorId}/events, signed with X-Hub-Signature-256. A pull request opened, merged " +
      "or closed, or a deployment, moves ONLY the task whose external_ref equals github:<owner>/<repo>#<number>, never on a " +
      "locked project, and never backwards; each move is audited with channel github. The webhook is called by GitHub, not by an agent.",
  },
  servers: [{ url: "https://stillnotbald.com/api", description: "Production" }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "PAT",
        description:
          "Scoped Personal Access Token (prefix npm_). Pass as Authorization: Bearer <token>. " +
          "Scopes follow resource:action convention (e.g. task:read, project:write). " +
          "Wildcards (* / resource:*) never grant approve/decide scopes — see the API description.",
      },
      cronSecret: {
        type: "http",
        scheme: "bearer",
        description:
          "NOT a PAT. The deployment's CRON_SECRET environment variable, sent by the host's cron " +
          "scheduler as Authorization: Bearer <CRON_SECRET> to GET /integrations/cron only. Compared in " +
          "constant time; an unset CRON_SECRET authorises nobody.",
      },
      relayHmac: {
        type: "apiKey",
        in: "header",
        name: "X-NoPM-Relay-Signature",
        description:
          "Self-host relay transport. Sign `<X-NoPM-Relay-Timestamp>.<raw body>` with HMAC-SHA256, using " +
          "as the key the 64-character lowercase-hex STRING of SHA-256(raw relay secret) — the hex text itself, " +
          "not its decoded bytes; the raw secret is shown once when the connector is created or the secret " +
          "rotated, and the server stores only that hash. Send `v1=<hex>` in X-NoPM-Relay-Signature " +
          "and the unix-seconds timestamp in X-NoPM-Relay-Timestamp (accepted within +/-300 s).",
      },
      larkWebhook: {
        type: "apiKey",
        in: "header",
        name: "X-Lark-Signature",
        description:
          "Called by Lark / Feishu, not by agents. With an Encrypt Key configured the request carries " +
          "X-Lark-Request-Timestamp, X-Lark-Request-Nonce and X-Lark-Signature = lowercase-hex SHA-256 of " +
          "timestamp + nonce + EncryptKey + raw body (timestamp within +/-5 min), and the body is " +
          "{ \"encrypt\": <base64 AES-256-CBC> } (key = SHA-256(EncryptKey), IV = first 16 bytes). The " +
          "connector's Verification Token (header.token, or top-level token for the url_verification " +
          "handshake) is always checked in constant time. Any failure is one generic 401.",
      },
    },
    schemas: {
      Success: {
        type: "object",
        required: ["data"],
        properties: {
          data: { description: "The response payload (object or array)" },
        },
      },
      SuccessList: {
        type: "object",
        required: ["data", "total", "page", "limit"],
        properties: {
          data: { type: "array", description: "Page of items" },
          total: { type: "integer", description: "Total matching records" },
          page: { type: "integer", description: "Current page (1-based)" },
          limit: { type: "integer", description: "Page size" },
        },
      },
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string", description: "Human-readable error message" },
          code: {
            type: "string",
            description:
              "Stable machine-readable error code, present on most errors (e.g. unauthorized, forbidden_scope, " +
              "not_found, rule_violation, rate_limited, precondition_failed, self_approval, no_principal, " +
              "already_decided, project_locked, " +
              "rebaseline_not_pending, already_applied, change_request_decided, children_changed, target_changed, target_gone, " +
              "bad_origin, invalid_reference, decision_in_use, " +
              "duplicate_deletion_request, has_timesheet_records). Branch on this, not on the message.",
          },
          fields: {
            type: "array",
            description: "Validation field errors (422 only)",
            items: {
              type: "object",
              properties: {
                field: { type: "string" },
                message: { type: "string" },
              },
            },
          },
        },
      },
      PendingApproval: {
        type: "object",
        description: "One governed decision waiting on a human (GET /review).",
        required: ["kind", "id", "title", "requested_at", "can_decide"],
        properties: {
          kind: { type: "string", enum: [...PENDING_KINDS], description: "Which maker-checker family this belongs to" },
          id: { type: "string", format: "uuid", description: "The request's id in its own family (deletion request, change request or rebaseline)" },
          title: { type: "string" },
          summary: { type: ["string", "null"], description: "One line of context (reason / status)" },
          project_id: { type: ["string", "null"], format: "uuid" },
          project_name: { type: ["string", "null"] },
          requested_by_label: { type: ["string", "null"] },
          requested_at: { type: "string", format: "date-time" },
          can_decide: { type: "boolean", description: "Whether THIS caller could decide it (decide scope + four-eyes by person). Advisory — the decision routes re-check everything." },
          reason_if_not: { type: ["string", "null"], description: "Why the caller cannot decide it; null when can_decide is true" },
          tier: { type: ["string", "null"], enum: [null, "routine", "normal", "high_risk", "strategic", "emergency"], description: "The approval tier; null when unknown" },
          approval_deadline_at: { type: ["string", "null"], format: "date-time", description: "When the turnaround timer expires; null for an emergency or a tier with no turnaround" },
          removes: {
            type: "array",
            description: "What approving also detaches or removes (a milestone's tasks, a project's records); empty otherwise",
            items: { type: "object", properties: { label: { type: "string" }, count: { type: "integer" }, governed: { type: "boolean" } } },
          },
        },
      },
      CalendarFeed: {
        type: "object",
        description: "A milestone calendar feed. The subscription secret is never part of this object; POST /calendar-feeds returns it once as `url`.",
        required: ["id", "name", "created_by", "created_at"],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          project_id: { type: ["string", "null"], format: "uuid", description: "null = every milestone in the workspace" },
          created_by: { type: "string", format: "uuid", description: "The person who owns the feed" },
          created_at: { type: "string", format: "date-time" },
          last_fetched_at: { type: ["string", "null"], format: "date-time" },
          revoked_at: { type: ["string", "null"], format: "date-time" },
          owner_name: { type: ["string", "null"], description: "Only on GET ?scope=workspace: the owner's display name" },
        },
      },
      GithubConnector: {
        type: "object",
        description:
          "Admin view of the workspace's GitHub connector. The webhook secret is WRITE-ONLY: it appears once, in the create " +
          "response and in the rotate response, and is never stored in readable form. Members see only { name, status }.",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          status: { type: "string", enum: ["active", "paused", "revoked"], description: "paused is the kill switch: every delivery answers 401" },
          webhook_url: { type: "string", format: "uri", description: "The address to paste into the GitHub repository webhook (content type application/json)" },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      GithubWorkEvent: {
        type: "object",
        description: "One GitHub delivery recorded against a pull request. Newest first in GET /integrations/github/work-events.",
        properties: {
          id: { type: "string", format: "uuid" },
          kind: { type: "string", enum: ["pr_opened", "pr_merged", "pr_closed", "deploy_success", "deploy_failure"] },
          ref: { type: "string", description: "github:<owner>/<repo>#<number>" },
          actor_login: { type: ["string", "null"] },
          task_id: { type: ["string", "null"], format: "uuid" },
          received_at: { type: "string", format: "date-time" },
          applied: { type: "boolean" },
          applied_status: { type: ["string", "null"], description: "The task status the event moved the task to, when it did" },
          reason: {
            type: "string",
            enum: ["received", "applied", "project_locked", "unknown_ref", "no_rule", "already_at_or_beyond", "task_canceled", "conflict", "no_linked_pr", "error", "replay", "truncated"],
          },
        },
      },
      LarkCallbackUrls: {
        type: "object",
        description: "The three URLs an admin pastes into the Lark / Feishu developer console (webhook mode uses events + card; the self-host worker uses relay).",
        properties: {
          events: { type: "string", format: "uri" },
          card: { type: "string", format: "uri" },
          relay: { type: "string", format: "uri" },
        },
      },
      IntegrationConnector: {
        type: "object",
        description:
          "Admin view of a connector. Secrets are WRITE-ONLY: only presence flags are returned, never a value, " +
          "ciphertext or hash.",
        properties: {
          id: { type: "string", format: "uuid" },
          kind: { type: "string", enum: ["lark"] },
          name: { type: "string" },
          status: { type: "string", enum: ["active", "paused", "revoked"] },
          region: { type: "string", enum: ["lark", "feishu"] },
          app_id: { type: "string" },
          mode: { type: "string", enum: ["webhook", "long_connection"], description: "webhook = hosted (the platform calls /events and /card); long_connection = self-host (the relay worker calls /relay)" },
          approvals: { type: "object", properties: { enabled: { type: "boolean" } } },
          digest: {
            type: "object",
            properties: {
              enabled: { type: "boolean" },
              chat_id: { type: ["string", "null"], description: "Lark group chat id (oc_...)" },
              weekday: { type: "integer", minimum: 0, maximum: 6, description: "0 = Sunday ... 6 = Saturday (UTC)" },
            },
          },
          has_app_secret: { type: "boolean" },
          has_verification_token: { type: "boolean" },
          has_encrypt_key: { type: "boolean" },
          secrets_readable: { type: "boolean", description: "false when the stored credentials cannot be decrypted (server key missing or rotated)" },
          has_relay_secret: { type: "boolean" },
          tenant_pinned: { type: "boolean", description: "true once the first account link by an ADMIN or MANAGER pinned the connector to one Lark tenant; a link by any other role never pins it (a non-approver cannot lock the real tenant out by linking from a foreign one) but is still refused when the connector is already pinned to a different tenant" },
          created_by: { type: ["string", "null"], format: "uuid" },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
          revoked_at: { type: ["string", "null"], format: "date-time" },
          callback_urls: { $ref: "#/components/schemas/LarkCallbackUrls" },
          health: {
            description:
              "Operator visibility (GET /integrations/connectors, admin view only). Counts and timestamps only — never a " +
              "payload or message text. null for a revoked connector, or when the lookup itself failed, so \"unknown\" " +
              "never reads as \"0 dead\". Absent from create / update / revoke responses.",
            oneOf: [{ $ref: "#/components/schemas/ConnectorHealth" }, { type: "null" }],
          },
        },
      },
      ConnectorHealth: {
        type: "object",
        description: "Delivery-queue health of one connector.",
        required: ["pending", "retry", "dead", "last_sent_at", "last_error", "last_cron_at", "last_cron"],
        properties: {
          pending: { type: "integer", description: "Queued and never attempted yet" },
          retry: { type: "integer", description: "Failed at least once and waiting for the next attempt (retries follow 1 m / 5 m / 30 m / 2 h / 12 h)" },
          dead: { type: "integer", description: "Gave up — a card that never reached anyone. Pruned after the retention window (60 days)." },
          last_sent_at: { type: ["string", "null"], format: "date-time", description: "When the most recent message went out" },
          last_error: { type: ["string", "null"], description: "Why the most recent failing delivery failed — already sanitised (no secrets), at most 300 characters" },
          last_cron_at: { type: ["string", "null"], format: "date-time", description: "When the daily scheduler last processed this connector (null if it never has, or the database has not applied migration 0051)" },
          last_cron: {
            description: "Counts from that scheduler run",
            oneOf: [
              {
                type: "object",
                properties: {
                  claimed: { type: "integer" },
                  sent: { type: "integer" },
                  retried: { type: "integer" },
                  dead: { type: "integer" },
                  superseded: { type: "integer" },
                  digest: { type: "string", enum: ["sent", "skipped", "queued", "failed"] },
                  partial: { type: "boolean", description: "true when the deadline or a timeout cut the pass short, so a backlog may remain for the next tick" },
                },
              },
              { type: "null" },
            ],
          },
        },
      },
      IntegrationConnectorRedacted: {
        type: "object",
        description:
          "What a non-admin member (viewers included) sees: that a live connector exists and what it does — no app id, " +
          "chat id, weekday, secrets, flags or callback URLs.",
        properties: {
          id: { type: "string", format: "uuid" },
          kind: { type: "string", enum: ["lark"] },
          name: { type: "string" },
          status: { type: "string", enum: ["active", "paused"] },
          region: { type: "string", enum: ["lark", "feishu"] },
          mode: { type: "string", enum: ["webhook", "long_connection"] },
          approvals: { type: "object", properties: { enabled: { type: "boolean" } } },
          digest: { type: "object", properties: { enabled: { type: "boolean" } } },
        },
      },
      LinkedIdentity: {
        type: "object",
        description: "A platform account linked to a NoPM user. The platform user id is returned masked (a hint to recognise the account, not a reusable id).",
        properties: {
          id: { type: "string", format: "uuid" },
          connector_id: { type: "string", format: "uuid" },
          provider: { type: "string", enum: ["lark"] },
          profile_id: { type: "string", format: "uuid", description: "The NoPM user this account is linked to" },
          profile_label: { type: ["string", "null"] },
          display_name: { type: ["string", "null"], description: "Name shown on the platform" },
          external_user_hint: { type: "string", description: "Masked platform user id" },
          linked_at: { type: "string", format: "date-time" },
        },
      },
      LarkCardCallbackResponse: {
        type: "object",
        description:
          "The reply Lark / Feishu expects to a card action: a toast shown to the person, plus optionally a " +
          "replacement for the card they pressed. This is the platform's contract, not the { data } envelope.",
        required: ["toast"],
        properties: {
          toast: {
            type: "object",
            required: ["type", "content"],
            properties: {
              type: { type: "string", enum: ["info", "success", "warning", "error"] },
              content: { type: "string", description: "One line, at most 200 characters" },
            },
          },
          card: {
            type: "object",
            description: "Replacement card (raw card JSON); present when the card should change in place",
            properties: { type: { type: "string", enum: ["raw"] }, data: { type: "object" } },
          },
        },
      },
    },
    parameters: {
      IdempotencyKey: {
        name: "Idempotency-Key",
        in: "header",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9_.:-]+$" },
        description:
          "Optional retry key (1-200 chars of A-Z a-z 0-9 _ . : -). A repeat of the same POST with the same key by the same " +
          "actor in the same workspace within 24 h returns the first result instead of creating a second record. " +
          "A malformed or empty key is 400 invalid_idempotency_key. Keys are scoped per workspace, actor and route (expenses and tasks include the project id). " +
          "Same key while the first request still runs: 409 idempotency_in_progress. Same key with a different body: 422 idempotency_key_reused.",
      },
    },
    responses: {
      RateLimited: {
        description:
          "429 — baseline rate limit exceeded (workspace+actor-class, fixed 60s window; " +
          "defaults 600/min read, 120/min write; configurable via NOPM_RATE_READ_PER_MIN / " +
          "NOPM_RATE_WRITE_PER_MIN). Applies to every authenticated route in this API — " +
          "documented once here rather than per-path. code: rate_limited. Always sends a Retry-After " +
          "header (integer seconds). Rate buckets are per actor id with a workspace ceiling of 5x; at most one " +
          "rate.limited audit row is written per actor per bucket per window.",
        headers: { "Retry-After": { schema: { type: "integer" }, description: "Seconds to wait before retrying" } },
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
      PreconditionFailed: {
        description:
          "412 — optimistic concurrency conflict (R-90). Returned only when the PATCH body " +
          "included expected_updated_at and the row's current updated_at no longer matches it " +
          "(someone else wrote it first). code: precondition_failed. The response body also " +
          "carries current_updated_at (the row's actual updated_at) when known, so the caller " +
          "can show/refresh the latest value and retry deliberately instead of blindly " +
          "overwriting it. Never returned when expected_updated_at is omitted from the body — " +
          "the field is opt-in and today's last-write-wins semantics are unchanged when absent. " +
          "Documented once here rather than per-path (applies to PATCH /projects/{id}, " +
          "/tasks/{id}, /milestones/{id}, /risks/{id}, /issues/{id}).",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/health": {
      get: {
        tags: ["system"],
        summary: "Liveness probe",
        description:
          "Public. No auth required. DB-free on purpose — it answers even when the database is the thing that is down. " +
          "`data.build` says which commit is deployed, so \"is live equal to main?\" can be answered from outside: " +
          "sha / ref are read from the host's environment (VERCEL_GIT_COMMIT_SHA / VERCEL_GIT_COMMIT_REF, or " +
          "NEXT_PUBLIC_BUILD_SHA for self-hosted images) and are null when the host exposes none — never an error.",
        security: [],
        operationId: "getHealth",
        responses: {
          "200": {
            description: "Service is up",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data"],
                  properties: {
                    data: {
                      type: "object",
                      required: ["status", "service", "time", "build"],
                      properties: {
                        status: { type: "string", enum: ["ok"] },
                        service: { type: "string", enum: ["nopm"] },
                        time: { type: "string", format: "date-time" },
                        build: {
                          type: "object",
                          required: ["sha", "ref"],
                          properties: {
                            sha: { type: ["string", "null"], description: "Deployed commit SHA, or null when the host exposes none" },
                            ref: { type: ["string", "null"], description: "Deployed git ref (branch), or null" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/tokens": {
      get: {
        tags: ["tokens"],
        summary: "List API tokens",
        description:
          "scope: admin or manager user session. Lists every credential of the workspace except the in-app assistant's " +
          "per-turn ephemeral tokens, which are hidden by their KIND (api_tokens.kind = 'assistant', set only by the " +
          "assistant's own mint path and not settable through POST /tokens) — never by name, so a token somebody " +
          "deliberately names \"AI Assistant · build\" still shows up in this inventory. Each row adds days_left and expiring_soon (true under 14 days left).",
        operationId: "listTokens",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": { description: "Paginated token list (token_hash never returned)", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
          "403": { description: "Forbidden", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["tokens"],
        summary: "Mint a new API token",
        description: "scope: admin or manager user session. Raw token returned once only. A token with an approve scope can decide only while its creator is an admin or manager. Refused on the shared demo login (403, code demo_restricted).",
        operationId: "createToken",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name", "scopes"], properties: { name: { type: "string" }, scopes: { type: "array", items: { type: "string" } }, expires_at: { type: "string", format: "date-time", description: "Optional. Default now + 90 days; more than 365 days ahead or in the past is 422 (owner decision 21)." } } } } } },
        responses: {
          "201": { description: "Token created (contains one-time `token` field)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/tokens/{id}": {
      delete: {
        tags: ["tokens"],
        summary: "Revoke a token",
        description: "scope: admin or manager user session. Sets revoked=true. Only user tokens can be revoked here (not the assistant's ephemeral tokens). Revoking an already-revoked token is 409.",
        operationId: "revokeToken",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Token revoked", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "409": { description: "Token already revoked (code already_revoked)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/invites": {
      get: {
        tags: ["invites"],
        summary: "List link invites (L-47/L-48)",
        description:
          "scope: admin or manager user session (D5 — token/agent actors get 403). status is a DERIVED " +
          "field (pending|accepted|revoked|expired), never a stored column. Optional ?status= filter.",
        operationId: "listInvites",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["pending", "accepted", "revoked", "expired"] } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": { description: "Paginated invite list (token_hash never returned)", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
          "403": { description: "Forbidden — not an admin/manager user session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["invites"],
        summary: "Create a link invite (L-47/L-48)",
        description:
          "scope: admin or manager user session (D5). Role-escalation cap: invite.role must be <= the " +
          "creator's own role rank (viewer<member<manager<admin) — a manager can never mint an admin " +
          "invite (422 rule_violation). Token prefix npi_ (distinct from api_tokens' npm_). expires_at = " +
          "now + 7 days. Raw invite link (invite_url) is returned ONCE and never stored/logged again. Accepting an invite is " +
          "retry-safe (a repeated accept does not fail half-way). 409 account_exists when the email already has an account; " +
          "403 demo_restricted on the shared demo login.",
        operationId: "createInvite",
        requestBody: zodBody(createInviteSchema),
        responses: {
          "201": { description: "Invite created (includes one-time invite_url)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Forbidden — not an admin/manager user session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error, role-escalation cap exceeded, or a pending invite already exists for this email", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/invites/{id}/revoke": {
      post: {
        tags: ["invites"],
        summary: "Revoke a pending link invite",
        description: "scope: admin or manager user session (D5). Only a pending invite may be revoked.",
        operationId: "revokeInvite",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Invite revoked", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Invite is not pending (already accepted/revoked/expired)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/change-requests/{id}/review": {
      post: {
        tags: ["change-requests"],
        summary: "Start review of a change request (raised to under_review)",
        description: "scope: change:decide. Admins and managers only (403 role_not_permitted). Moves a raised change request to under_review and writes a change_request.start_review audit row. Any other status is refused.",
        operationId: "startChangeRequestReview",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "The updated change request", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin or manager, or missing change:decide", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "The request is not in the raised state", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/change-requests/{id}/reopen": {
      post: {
        tags: ["change-requests"],
        summary: "Reopen a deferred change request (deferred to under_review)",
        description: "scope: change:write. The requester (same person, including a token they minted) or any admin or manager. A deferred request is parked, not final: reopening returns it to under_review for a fresh decision (owner decision 24). Audited as change_request.reopen. Any status other than deferred is refused.",
        operationId: "reopenChangeRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "The reopened change request", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not the requester and not an admin or manager (not_requester), or token with no recorded owner (no_principal)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "The request is not deferred", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/rebaselines/{id}/withdraw": {
      post: {
        tags: ["rebaselines"],
        summary: "Withdraw a rebaseline that is waiting for sign-off",
        description: "scope: project:write. Only the proposer (the same person, including a token they minted) may withdraw: 403 not_requester for anyone else, 403 no_principal for a token with no recorded owner. Only while pending_approval: otherwise 422 rebaseline_not_pending. The rebaseline becomes cancelled and a rebaseline.withdrawn audit row is written; approvers chat cards are retired.",
        operationId: "withdrawRebaseline",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "The withdrawn (cancelled) rebaseline", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not the proposer (not_requester) or no recorded owner (no_principal)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Not waiting for sign-off (rebaseline_not_pending)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/invites/{id}/renew": {
      post: {
        tags: ["invites"],
        summary: "Renew an expired link invite",
        description: "scope: admin or manager user session. Only an EXPIRED invite can be renewed (422 not_expired otherwise); expires_at becomes now + 7 days and the same link works again. A manager cannot renew an invite an admin created (403 admin_created: Only an admin can revoke something an admin created.). Audited as invite.renewed.",
        operationId: "renewInvite",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "The renewed invite with its derived status", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin or manager session, or admin_created", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Invite is not expired (code not_expired)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/members": {
      get: {
        tags: ["members"],
        summary: "List workspace members (people)",
        description: "scope: admin or manager USER SESSION only; a personal access token is refused. Returns every person in the workspace including removed ones (status removed) so they can be restored.",
        operationId: "listMembers",
        parameters: [],
        responses: {
          "200": { description: "Members list (id, display name, email, role, status, two-step state)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin or manager session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/members/{id}": {
      patch: {
        tags: ["members"],
        summary: "Change a member role (admin)",
        description: "scope: admin USER SESSION only, never a token. Body { role: viewer|member|manager|admin }. Codes: last_admin (cannot demote the last admin), no_change (already that role), member_removed. Audited as member.role_change.",
        operationId: "changeMemberRole",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["role"], properties: { role: { type: "string", enum: ["viewer", "member", "manager", "admin"] } } } } } },
        responses: {
          "200": { description: "The updated member", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "last_admin, no_change, member_removed, or validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["members"],
        summary: "Remove a member (leaver) or leave the workspace yourself",
        description: "scope: admin USER SESSION, or a person removing themselves (self-leave). Never a token. Removal sets the profile status to removed, bans the login, revokes the person tokens and cancels their pending invites; their history stays. The last admin cannot be removed (422 last_admin); removing someone already removed is 422 member_removed. Audited as member.remove. This is the leaver step in the user-provisioning runbook.",
        operationId: "removeMember",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "The removal result", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin session and not removing yourself", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "last_admin or member_removed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/members/{id}/restore": {
      post: {
        tags: ["members"],
        summary: "Restore a removed member",
        description: "scope: admin USER SESSION only. Optional body { role } (default: their previous role, capped by the caller own rank; 422 role_escalation). Un-bans the login. 422 member_not_removed when the person is not removed. Audited as member.restore.",
        operationId: "restoreMember",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { role: { type: "string", enum: ["viewer", "member", "manager", "admin"] } } } } } },
        responses: {
          "200": { description: "The restored member", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "member_not_removed, role_escalation, or validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/members/{id}/mfa-reset": {
      post: {
        tags: ["members"],
        summary: "Reset a member two-step sign-in (admin)",
        description: "scope: admin USER SESSION only. Clears the person two-step factor and returns fresh backup_codes ONCE in the response. You cannot reset your own (422 self_reset: use Settings). 422 member_removed for a removed person. Audited as member.mfa_reset.",
        operationId: "resetMemberMfa",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Reset done; data.backup_codes shown once", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "self_reset or member_removed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/workspace-settings": {
      get: {
        tags: ["workspace"],
        summary: "Read workspace settings (time zone)",
        description: "scope: any authenticated caller. Returns { time_zone, default_time_zone, stale_days, nudges_enabled, weekly_report_enabled, weekly_report_day, approval_policy }. approval_policy (wave 4) is always complete with every default filled in: { tiers: { routine | normal | high_risk | emergency | strategic: { approver_role: manager | admin, turnaround_hours (0-8760; 0 = no timer), auto_approve (boolean; true only on routine) } }, currency_threshold (default 50000), currency (a LABEL, default MYR or null: every cost is compared as a plain number in that currency and nothing is converted), schedule_threshold_days (0-3650, default 10: a schedule impact above it lifts a normal request to high_risk), emergency_retro_hours (deprecated: accepted and ignored, nothing new is stored and it has no effect) }. Defaults: routine and normal decided by a manager; high_risk and strategic by an admin; turnaround 24, 48, 72, 0 and 120 hours; auto_approve off everywhere. The time zone default is Asia/Kuala_Lumpur. stale_days (1-365, default 14) is the age after which an open item is nudged as stale; weekly_report_day is an ISO weekday (1 = Monday) read in time_zone. Server-side defaults (due dates, sprint timing, reminders) follow the time zone.",
        operationId: "getWorkspaceSettings",
        parameters: [],
        responses: {
          "200": { description: "{ time_zone, default_time_zone }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
        },
      },
      patch: {
        tags: ["workspace"],
        summary: "Change the workspace time zone (admin)",
        description: "scope: admin USER SESSION only. Body is any non-empty subset of time_zone (an IANA name such as Asia/Kuala_Lumpur), stale_days (integer 1-365), nudges_enabled, weekly_report_enabled (booleans) and weekly_report_day (integer 1-7, ISO weekday). A bad value is 422 Validation failed with fields, and nothing is saved. One workspace.settings_update audit row holds only the fields that changed; no row is written when nothing changed. approval_policy (wave 4) takes any subset of the GET shape: only the rules sent change, the rest keep their stored value. Unknown keys and unknown tiers are 422. auto_approve true is allowed only on routine. The whole change is one workspace.settings_update audit row with before and after holding approval_policy, written in the same transaction as the change. The save is pinned to the values the admin read: if another admin changed the same setting since, the save is refused with 412 precondition_failed.",
        operationId: "updateWorkspaceSettings",
        parameters: [],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", minProperties: 1, properties: { time_zone: { type: "string", example: "Asia/Kuala_Lumpur" }, stale_days: { type: "integer", minimum: 1, maximum: 365 }, nudges_enabled: { type: "boolean" }, weekly_report_enabled: { type: "boolean" }, weekly_report_day: { type: "integer", minimum: 1, maximum: 7, description: "ISO weekday, 1 = Monday" }, approval_policy: { type: "object", description: "Any subset of { tiers, currency_threshold, currency, schedule_threshold_days, emergency_retro_hours } as described on GET" } } } } } },
        responses: {
          "200": { description: "{ time_zone, default_time_zone }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "412": { description: "precondition_failed — approval_policy was pinned to the values this admin read, and another admin changed the same setting since. Reload the settings and save again.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Not a valid IANA time zone, or an unknown field, tier or value in approval_policy (auto_approve true on a tier other than routine included)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/integrations/connectors/{id}/deliveries": {
      get: {
        tags: ["integrations"],
        summary: "List failed or retrying chat messages",
        description: "scope: admin user session only. ?status=dead (default) or retry; newest first, at most 50. Each row: id, kind, approval_kind, approval_id, status, attempts, last_error (sanitised, truncated), created_at, next_attempt_at.",
        operationId: "listConnectorDeliveries",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }, { name: "status", in: "query", schema: { type: "string", enum: ["dead", "retry"], default: "dead" } }],
        responses: {
          "200": { description: "List of deliveries", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Connector not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/integrations/connectors/{id}/deliveries/{deliveryId}/retry": {
      post: {
        tags: ["integrations"],
        summary: "Retry one failed chat message",
        description: "scope: admin user session only. Re-queues a dead delivery and attempts it once immediately. 422 connector_not_active (connector paused or revoked), 422 delivery_not_dead (only a dead message can be retried), 422 delivery_already_queued (a newer copy exists). Audited as integration.delivery.retry. Returns { delivery_id, status }.",
        operationId: "retryConnectorDelivery",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }, { name: "deliveryId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "{ delivery_id, status: sent|retry|dead|superseded|queued }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Connector or delivery not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "connector_not_active, delivery_not_dead or delivery_already_queued", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/invites/accept": {
      post: {
        tags: ["invites"],
        summary: "Accept a link invite — provisions a new login (L-47/L-48)",
        description:
          "No auth required — this is the one route in NoPM that creates a brand-new auth user from an " +
          "unauthenticated request. Rate-limited explicitly (10/req per minute, keyed by client network — this " +
          "endpoint cannot use the baseline actor-keyed limiter since there is no actor pre-auth). The key is the " +
          "address YOUR proxy appended to X-Forwarded-For (IPv6 collapsed to its /64), never the caller's own first " +
          "entry, which a caller can rotate for a fresh bucket each request: on Vercel it is read from the platform's " +
          "header; anywhere else NOTHING is trusted unless NOPM_TRUSTED_PROXY_HOPS is set to the number of reverse " +
          "proxies in front of the app — with no trustworthy address every caller shares ONE conservative bucket. Body " +
          "has NO email field: the accepted email is always the invite's own. Ordering (D6): " +
          "admin.auth.admin.createUser FIRST (email_confirm: true), THEN the atomic nopm_accept_invite " +
          "RPC (writes profiles + resource_members + marks the invite + 2 audit rows in one transaction). " +
          "If the RPC fails after createUser succeeded, the auth user is best-effort cleaned up " +
          "(admin.auth.admin.deleteUser). No server-minted session is returned — the client signs in " +
          "normally via /login afterwards. Anti-enumeration (T3, F2c-mini): a missing, already-used, " +
          "revoked, or expired invite ALL return the SAME 422 with the SAME message — there is " +
          "deliberately no distinct 404 for 'not found' (a scripted caller cannot distinguish invite " +
          "states from this endpoint's response). The public /invite/[token] page keeps distinct " +
          "friendly per-status copy — that asymmetry is intentional, see invite-guard.ts.",
        security: [],
        operationId: "acceptInvite",
        requestBody: zodBody(acceptInviteSchema),
        responses: {
          "200": { description: "Account created (workspace + email echoed back; no session)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error; OR the invite link is not valid or has expired (uniform anti-enumeration message covering not-found/already-used/revoked/expired — never a distinct 404); OR an account with this email already exists (kept distinct — the caller already holds a valid token for that email)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "Rate limit exceeded (10/min per IP)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects": {
      get: {
        tags: ["projects"],
        summary: "List projects",
        description: "scope: project:read. Filters: source, external_ref (complement seam, R-81 — both exact-match).",
        operationId: "listProjects",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
          { name: "source", in: "query", schema: { type: "string" }, description: "Exact-match on the system-of-work slug this project mirrors (e.g. jira)" },
          { name: "external_ref", in: "query", schema: { type: "string" }, description: "Exact-match on the id/key in that external system" },
          ...listViewParams,
        ],
        responses: {
          "200": { description: "Paginated project list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["projects"],
        summary: "Create a project",
        description:
          "scope: project:write. A project is never created locked: is_locked (and locked_at / locked_by) in the body are " +
          "ignored. Locking happens only through POST /projects/{id}/lock, which also snapshots the baselines. " +
          "backup_owner_id (uuid or null) names a backup owner: a profile in this workspace, different from owner_id (422 invalid_reference, or a field-named 422 when equal).",
        operationId: "createProject",
        requestBody: zodBody(createProjectSchema),
        responses: {
          "201": { description: "Project created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}": {
      get: {
        tags: ["projects"],
        summary: "Get a project",
        description: "scope: project:read",
        operationId: "getProject",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Project", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["projects"],
        summary: "Update a project",
        description:
          "scope: project:write. A LOCKED project's baseline is frozen: changing start_date, target_date, baseline_start_date " +
          "or baseline_target_date is refused with 422 project_locked (recorded as a project.update.blocked audit row), exactly " +
          "as for tasks and milestones — the way to move a frozen baseline is a governed unlock or an approved rebaseline, " +
          "never one holder of project:write. A field sent with its stored value is not a change. Name, owner, RAG, " +
          "commentary and the rest stay editable under lock. owner_id must be a member of THIS workspace (422 " +
          "invalid_reference otherwise). backup_owner_id (uuid or null; null clears, omitting keeps) must be a member of THIS workspace and differ from owner_id (422). program_id (uuid or null) is accepted on create and PATCH; a program outside the workspace is 422. completion_pct is calculated from the tasks: a PATCH that sends a value different from the stored one is 422 (\"Project completion is calculated from its tasks\").",
        operationId: "updateProject",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(updateProjectSchema),
        responses: {
          "200": { description: "Updated project", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "412": { $ref: "#/components/responses/PreconditionFailed" },
          "422": { description: "Validation error; project_locked (the patch changes a schedule date of a locked project); or invalid_reference (owner_id)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["projects"],
        summary: "Request project deletion (maker step)",
        description:
          "scope: project:delete:request. Does NOT delete the project. Creates a deletion_request " +
          "(target_type=project, status=pending) — mirrors task deletion's maker step (see DELETE " +
          "/tasks/{id}). Requires reason in the body (goes to the audit trail). Returns 202. A different " +
          "PERSON must approve it via POST /deletion-requests/{id}/approve to commit the deletion — see " +
          "that operation for the target-type dispatch and current approve-scope gate. Like task " +
          "deletion, a LOCKED project is refused at this request step (422, code project_locked, recorded " +
          "as a project.delete_request.blocked audit row) rather than left to sit in the approvers' queue; " +
          "the atomic commit RPC re-checks the lock at approval as a backstop for a lock applied after " +
          "the request was raised. A token with no recorded owner cannot raise the request (403, code no_principal): its " +
          "requester principal would be null, comparable to nobody. The request snapshots not only the project row but " +
          "how many rows of each child kind hang off it (before.child_counts, plus a _scope fingerprint of the project row and " +
          "the child ids); if the project or its records change afterwards, " +
          "the approval is refused (422 children_changed) so an approver never destroys children they were not shown. " +
          "WAVE 4: the request carries tier (high_risk by default, so an admin decides it unless the workspace " +
          "approval policy says otherwise) and approval_deadline_at.",
        operationId: "requestProjectDeletion",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(ProjectDeleteRequestSchema),
        responses: {
          "202": { description: "Deletion request created (pending)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Missing project:delete:request (forbidden_scope), or the token has no recorded owner (no_principal)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error (reason required); project_locked (the project is locked — refused at request time); or a pending deletion request already exists for this project (code duplicate_deletion_request)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/programs": {
      get: {
        tags: ["programs"],
        summary: "List programs",
        description: "scope: program:read",
        operationId: "listPrograms",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": { description: "Paginated program list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["programs"],
        summary: "Create a program",
        description: "scope: program:write",
        operationId: "createProgram",
        requestBody: zodBody(createProgramSchema),
        responses: {
          "201": { description: "Program created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/programs/{id}": {
      get: {
        tags: ["programs"],
        summary: "Get a program",
        description: "scope: program:read",
        operationId: "getProgram",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Program", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["programs"],
        summary: "Update a program",
        description: "scope: program:write",
        operationId: "updateProgram",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(updateProgramSchema),
        responses: {
          "200": { description: "Updated program", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["programs"],
        summary: "Delete a program",
        description:
          "scope: program:write. PLAIN single-step hard delete with one audit row (program.delete) — " +
          "NOT routed through deletion_requests. Owner-locked (Decision 3, requirements/devops-wave1/" +
          "README.md): the four-eyes maker-checker flow stays PROJECTS ONLY; programs behave like " +
          "milestones/risks/issues here. Deleting a program never deletes its child projects — " +
          "projects.program_id is FK'd ON DELETE SET NULL, so children simply lose the grouping.",
        operationId: "deleteProgram",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Program deleted" },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/sprints": {
      get: {
        tags: ["sprints"],
        summary: "List sprints",
        description: "scope: sprint:read. Filters: project_id, state (planned|active|closed). Ordered start_date desc.",
        operationId: "listSprints",
        parameters: [
          { name: "project_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "state", in: "query", schema: { type: "string", enum: ["planned", "active", "closed"] } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": { description: "Paginated sprint list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["sprints"],
        summary: "Create a sprint",
        description: "scope: sprint:write. project_id must belong to the caller's workspace (404 otherwise). Created in state=planned.",
        operationId: "createSprint",
        requestBody: zodBody(createSprintSchema),
        responses: {
          "201": { description: "Sprint created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Project not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/sprints/{id}": {
      get: {
        tags: ["sprints"],
        summary: "Get a sprint",
        description: "scope: sprint:read",
        operationId: "getSprint",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Sprint", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["sprints"],
        summary: "Update a sprint",
        description:
          "scope: sprint:write. Only name/goal/dates — state is NEVER settable here (use /start and " +
          "/close). A closed sprint rejects every PATCH (422).",
        operationId: "updateSprint",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(updateSprintSchema),
        responses: {
          "200": { description: "Updated sprint", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error or closed sprint", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["sprints"],
        summary: "Delete a sprint",
        description:
          "scope: sprint:write. PLAIN single-step hard delete with one audit row (sprint.delete) — " +
          "NOT routed through deletion_requests. Only while state=planned AND no tasks are attached " +
          "(422 otherwise).",
        operationId: "deleteSprint",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Sprint deleted" },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Sprint is not planned, or has attached tasks", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/sprints/{id}/start": {
      post: {
        tags: ["sprints"],
        summary: "Start a sprint (planned -> active)",
        description:
          "scope: sprint:write. Snapshots committed_points/committed_snapshot from every task currently " +
          "attached (sprint_id = this sprint). Written once — never recomputed by a later story-point " +
          "edit. 422 if the sprint is not currently planned.",
        operationId: "startSprint",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Started sprint", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Sprint is not planned", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/sprints/{id}/close": {
      post: {
        tags: ["sprints"],
        summary: "Close a sprint (active -> closed)",
        description:
          "scope: sprint:write. Snapshots completed_points/completed_snapshot from attached tasks whose " +
          "status_type='completed' at this instant. Written once — never recomputed afterwards. 422 if " +
          "the sprint is not currently active. Body is optional: move_unfinished_to (\"backlog\" or the id of another " +
          "planned/active sprint of the same project) says where attached tasks that are not finished go. When any are " +
          "unfinished and move_unfinished_to is missing the close is refused (422 unfinished_tasks, nothing changes): ask the " +
          "person, then resend. Finished tasks stay with the closed sprint. The moved task ids are recorded in the single " +
          "sprint.closed audit row.",
        operationId: "closeSprint",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(closeSprintSchema, false),
        responses: {
          "200": { description: "Closed sprint", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Sprint is not active, or unfinished_tasks (resend with move_unfinished_to)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/sprints/{id}/tasks": {
      post: {
        tags: ["sprints"],
        summary: "Attach a task to a sprint",
        description:
          "scope: sprint:write. The task must exist in this workspace AND already belong to the sprint's " +
          "own project (422 otherwise, not 404 — the combination is invalid, not the sprint id). 422 if " +
          "the sprint is closed, or if the task belongs to a closed sprint (422 \"This task belongs to a closed sprint and cannot be moved to another sprint\").",
        operationId: "attachSprintTask",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(sprintTaskAttachSchema),
        responses: {
          "200": { description: "Updated task (now attached)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Sprint not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Task not in this workspace/project, or sprint closed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["sprints"],
        summary: "Detach a task from a sprint",
        description:
          "scope: sprint:write. ?task_id=<uuid> required. The task must currently be attached to THIS " +
          "sprint (422 otherwise). 422 if the sprint is closed.",
        operationId: "detachSprintTask",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "task_id", in: "query", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": { description: "Updated task (now detached)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Sprint not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Task not attached to this sprint, missing task_id, or sprint closed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/saved-views": {
      get: {
        tags: ["saved-views"],
        summary: "List saved views",
        description:
          "scope: saved_view:read. Returns the caller's OWN personal views plus every shared view " +
          "in the workspace — never another identity's personal view (L-41). Optional ?register= " +
          "filters to one register's views (e.g. tasks, risks, issues, clashes).",
        operationId: "listSavedViews",
        parameters: [
          { name: "register", in: "query", schema: { type: "string" } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": { description: "Paginated saved-view list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["saved-views"],
        summary: "Create a saved view",
        description:
          "scope: saved_view:write. Captures filters+sort+columns+groupBy as config jsonb. " +
          "A token/agent caller's view is always forced to scope=shared — tokens have no profiles " +
          "row to privately own a personal view with.",
        operationId: "createSavedView",
        requestBody: zodBody(createSavedViewSchema),
        responses: {
          "201": { description: "Saved view created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/saved-views/{id}": {
      get: {
        tags: ["saved-views"],
        summary: "Get a saved view",
        description: "scope: saved_view:read. 404 (not 403) if the view is personal and belongs to a different identity.",
        operationId: "getSavedView",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Saved view", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found (or not visible to this identity)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["saved-views"],
        summary: "Update a saved view",
        description:
          "scope: saved_view:write. Only the owner or a workspace admin may mutate (403 otherwise). " +
          "A protected view rejects a config-changing PATCH with 403 unless the SAME call also sets " +
          "protected:false (L-07). Scope (share/unshare) and protected toggles are each audited under " +
          "their own action name (saved_view.shared / saved_view.protected) — L-06/L-07.",
        operationId: "updateSavedView",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(updateSavedViewSchema),
        responses: {
          "200": { description: "Updated saved view", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not the owner/admin, or config PATCH rejected on a still-protected view", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["saved-views"],
        summary: "Delete a saved view",
        description: "scope: saved_view:write. Plain single-step hard delete, one audit row — NOT maker-checker.",
        operationId: "deleteSavedView",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "403": { description: "Not the owner/admin", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/saved-views/{id}/duplicate": {
      post: {
        tags: ["saved-views"],
        summary: "Duplicate a saved view into a personal copy",
        description:
          "scope: saved_view:write. Clones any visible view — including a protected one (L-07: " +
          "protection guards the original from silent edit, not from being forked) — into a fresh, " +
          "unprotected personal copy owned by the caller. User sessions only: a token/agent actor has " +
          "no owning identity for the copy.",
        operationId: "duplicateSavedView",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } },
        responses: {
          "201": { description: "Duplicated saved view", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Token/agent actor attempted a duplicate (no owning identity)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/milestones": {
      get: {
        tags: ["milestones"],
        summary: "List milestones for a project",
        description: "scope: milestone:read",
        operationId: "listProjectMilestones",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
          ...listViewParams,
        ],
        responses: {
          "200": { description: "Paginated milestone list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["milestones"],
        summary: "Create a milestone under a project",
        description: "scope: milestone:write. 422 project_locked when the project is locked. Saves description, deliverable, start_date, baseline_target_date and actual_date as well as the core fields.",
        operationId: "createMilestone",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(createMilestoneSchema),
        responses: {
          "201": { description: "Milestone created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error, or project_locked when the project is locked", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/milestones/{id}": {
      get: {
        tags: ["milestones"],
        summary: "Get a milestone",
        description: "scope: milestone:read",
        operationId: "getMilestone",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Milestone", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["milestones"],
        summary: "Update a milestone",
        description: "scope: milestone:write. 422 project_locked when the patch touches a schedule-shape field (target_date/baseline_target_date) and the project is locked; status/etc. edits stay live under lock. Saves description, deliverable, start_date, baseline_target_date and actual_date. Setting status to completed while the milestone still has open tasks is refused 422 open_tasks (\"N tasks are still open. Complete this milestone anyway?\"): resend the same PATCH with confirm_open_tasks: true (a flag, never stored) once the person agrees; the audit row records completed_with_open_tasks.",
        operationId: "updateMilestone",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(updateMilestoneSchema),
        responses: {
          "200": { description: "Updated milestone", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "412": { $ref: "#/components/responses/PreconditionFailed" },
          "422": { description: "project_locked — the patch touches a schedule-shape field and the project is locked", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["milestones"],
        summary: "Request milestone deletion (maker step)",
        description:
          "scope: milestone:delete:request (milestone:write no longer deletes). Does NOT delete the milestone (deletion by request, audit gap G8). " +
          "Body: reason (required, max 1000) and assigned_approver_id (optional). Creates a deletion_request (target_type=milestone) and returns 202 with it. " +
          "A different PERSON holding milestone:delete:approve and an approver role must approve it at POST /deletion-requests/{id}/approve; approving " +
          "unlinks the milestone's tasks and keeps them. The request records how many tasks the milestone holds, and approval is refused " +
          "422 children_changed if that number has moved. 422 project_locked while the project is locked (recorded as milestone.delete_request.blocked). " +
          "422 duplicate_deletion_request if one is already pending. A token with no recorded owner is 403 no_principal.",
        operationId: "deleteMilestone",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["reason"], properties: { reason: { type: "string", maxLength: 1000 }, assigned_approver_id: { type: ["string", "null"], format: "uuid" } } } } } },
        responses: {
          "202": { description: "Deletion request created (pending) — { data: deletion_request }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Missing milestone:delete:request (forbidden_scope), or no recorded owner (no_principal)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "project_locked — the project is locked; duplicate_deletion_request — a request is already pending; or validation error (reason required)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/tasks": {
      get: {
        tags: ["tasks"],
        summary: "List tasks for a project",
        description: "scope: task:read",
        operationId: "listProjectTasks",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
          ...listViewParams,
        ],
        responses: {
          "200": { description: "Paginated task list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["tasks"],
        summary: "Create a task in a project",
        description: "scope: task:write. 422 project_locked when the project is locked. Send Idempotency-Key to make a retry return the first task.",
        operationId: "createTask",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }, { $ref: "#/components/parameters/IdempotencyKey" }],
        requestBody: zodBody(TaskCreateSchema),
        responses: {
          "201": { description: "Task created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error, or project_locked when the project is locked", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/tasks": {
      get: {
        tags: ["tasks"],
        summary: "Cross-project task list (L-04)",
        description: "scope: task:read. Workspace-scoped (not per-project). Filters: project_id, assignee_id, status_type, priority, due_before, due_after, overdue=true, q (name ilike), source, external_ref (complement seam, R-81 — both exact-match). Sort (L-10): ?sort=field:asc|desc against a whitelist (due_date|priority|status_type|name|created_at|completion_pct) — an unknown field or direction 422s. Reused verbatim by GET /export?entity=tasks.",
        operationId: "listTasks",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
          { name: "sort", in: "query", schema: { type: "string" }, description: "field:asc|desc — see description for the field whitelist" },
          { name: "project_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "assignee_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "status_type", in: "query", schema: { type: "string" } },
          { name: "priority", in: "query", schema: { type: "string" } },
          { name: "due_before", in: "query", schema: { type: "string", format: "date" } },
          { name: "due_after", in: "query", schema: { type: "string", format: "date" } },
          { name: "overdue", in: "query", schema: { type: "boolean" } },
          { name: "q", in: "query", schema: { type: "string" }, description: "Case-insensitive substring match against task name" },
          { name: "source", in: "query", schema: { type: "string" }, description: "Exact-match on the system-of-work slug this task mirrors (e.g. jira)" },
          { name: "external_ref", in: "query", schema: { type: "string" }, description: "Exact-match on the id/key in that external system" },
          ...listViewParams,
        ],
        responses: {
          "200": { description: "Paginated cross-project task list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
          "422": { description: "Unknown sort field or direction", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/tasks/{id}": {
      get: {
        tags: ["tasks"],
        summary: "Get a task",
        description: "scope: task:read",
        operationId: "getTask",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Task", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["tasks"],
        summary: "Update a task",
        description: "scope: task:write. Kanban status moves are audited. 422 project_locked when the patch touches a schedule-shape field (dates/estimate_hours/milestone_id) and the project is locked; status/checklist/assignee/etc. edits stay live under lock. WAVE 4: external_ref with source github links a pull request: external_ref is github:<owner>/<repo>#<number> and source is github; the match is exact, so store the reference in lower case as the Link PR field does. A malformed GitHub reference (not github:<owner>/<repo>#<number>) is refused with 422. A linked task moves on GitHub work events (see POST /integrations/github/{connectorId}/events); a task on a locked project never moves.",
        operationId: "updateTask",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(TaskUpdateSchema),
        responses: {
          "200": { description: "Updated task", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "412": { $ref: "#/components/responses/PreconditionFailed" },
          "422": { description: "project_locked — the patch touches a schedule-shape field and the project is locked", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["tasks"],
        summary: "Request task deletion (maker step)",
        description: "scope: task:delete:request. Does NOT delete the task. Creates a deletion_request with status=pending, tier normal and approval_deadline_at. Returns 202. A different PERSON holding scope task:delete:approve must approve it (a token you minted counts as you). A token with no recorded owner cannot raise the request (403, code no_principal). 422 project_locked when the project is locked (deletion always reshapes the schedule).",
        operationId: "requestTaskDeletion",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(TaskDeleteRequestSchema),
        responses: {
          "202": { description: "Deletion request created (pending)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Missing task:delete:request (forbidden_scope), or the token has no recorded owner (no_principal)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Duplicate pending request (code duplicate_deletion_request), or project_locked when the project is locked", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/risks": {
      get: {
        tags: ["risks"],
        summary: "List risks for a project",
        description: "scope: risk:read. Filters: source, external_ref (complement seam, R-81 — both exact-match).",
        operationId: "listProjectRisks",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
          { name: "source", in: "query", schema: { type: "string" }, description: "Exact-match on the system-of-work slug this risk mirrors (e.g. jira)" },
          { name: "external_ref", in: "query", schema: { type: "string" }, description: "Exact-match on the id/key in that external system" },
          ...listViewParams,
          { name: "impact_area", in: "query", schema: { type: "string" }, description: "Any-of filter on impact areas, comma-separated (e.g. cost,schedule): a risk matches when it touches ANY listed area. Values: schedule | cost | scope | quality | reputation | compliance" },
        ],
        responses: {
          "200": { description: "Paginated risk list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["risks"],
        summary: "Create a risk under a project",
        description: "scope: risk:write. Saves every schema field: probability_pct, impact_score, response_strategy, risk_category (technical | schedule | cost | resourcing | scope_requirements | supplier_external | regulatory_legal | organisational), impact_areas (array of schedule | cost | scope | quality | reputation | compliance; impact_area is accepted as a one-element shorthand), trigger, residual_risk. The legacy free-text category is no longer accepted (use risk_category).",
        operationId: "createRisk",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(createRiskSchema),
        responses: {
          "201": { description: "Risk created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/risks/{id}": {
      get: {
        tags: ["risks"],
        summary: "Get a risk",
        description: "scope: risk:read",
        operationId: "getRisk",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Risk", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["risks"],
        summary: "Update a risk",
        description: "scope: risk:write. Saves every schema field (probability_pct, impact_score, response_strategy, risk_category (technical | schedule | cost | resourcing | scope_requirements | supplier_external | regulatory_legal | organisational), impact_areas (array; impact_area is accepted as a one-element shorthand), trigger, residual_risk). The legacy free-text category is no longer accepted. Raising severity to high or critical sends the same risk.escalated notification as create. Setting status to closed needs a resolution note (up to 4000 chars, sent in the same PATCH or already stored): otherwise 422 with the field error on resolution.",
        operationId: "updateRisk",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(updateRiskSchema),
        responses: {
          "200": { description: "Updated risk", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "412": { $ref: "#/components/responses/PreconditionFailed" },
        },
      },
      delete: {
        tags: ["risks"],
        summary: "Request risk deletion (maker step)",
        description:
          "scope: risk:delete:request (the older risk:delete is accepted and means the same; plain risk:write cannot delete, and risk:* does not grant the approve scope). " +
          "Does NOT delete the risk. Body: reason (required, max 1000) and assigned_approver_id (optional). Creates a deletion_request (target_type=risk) and returns 202. " +
          "A different PERSON holding risk:delete:approve and an approver role must approve it at POST /deletion-requests/{id}/approve. Audit: risk.delete_requested now, risk.delete on approval.",
        operationId: "deleteRisk",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["reason"], properties: { reason: { type: "string", maxLength: 1000 }, assigned_approver_id: { type: ["string", "null"], format: "uuid" } } } } } },
        responses: {
          "202": { description: "Deletion request created (pending) — { data: deletion_request }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Missing risk:delete:request (forbidden_scope), or no recorded owner (no_principal)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "duplicate_deletion_request — a request is already pending; or validation error (reason required)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/issues": {
      get: {
        tags: ["issues"],
        summary: "List issues for a project",
        description: "scope: issue:read. Filters: source, external_ref (complement seam, R-81 — both exact-match).",
        operationId: "listProjectIssues",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
          { name: "source", in: "query", schema: { type: "string" }, description: "Exact-match on the system-of-work slug this issue mirrors (e.g. jira)" },
          { name: "external_ref", in: "query", schema: { type: "string" }, description: "Exact-match on the id/key in that external system" },
          ...listViewParams,
        ],
        responses: {
          "200": { description: "Paginated issue list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["issues"],
        summary: "Create an issue under a project",
        description: "scope: issue:write. Saves every schema field: severity, issue_category (technical_fault | resourcing | schedule_delay | cost_overrun | scope_change | organisational | supplier | external_event), impact, resolution_eta, resolved_at.",
        operationId: "createIssue",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(createIssueSchema),
        responses: {
          "201": { description: "Issue created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/issues/{id}": {
      get: {
        tags: ["issues"],
        summary: "Get an issue",
        description: "scope: issue:read",
        operationId: "getIssue",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Issue", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["issues"],
        summary: "Update an issue",
        description: "scope: issue:write. Saves every schema field: severity, issue_category (technical_fault | resourcing | schedule_delay | cost_overrun | scope_change | organisational | supplier | external_event), impact, resolution_eta, resolved_at. Setting status to resolved or closed needs a resolution note (sent in the same PATCH or already stored): otherwise 422 with the field error on resolution.",
        operationId: "updateIssue",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(updateIssueSchema),
        responses: {
          "200": { description: "Updated issue", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "412": { $ref: "#/components/responses/PreconditionFailed" },
        },
      },
      delete: {
        tags: ["issues"],
        summary: "Request issue deletion (maker step)",
        description:
          "scope: issue:delete:request (the older issue:delete is accepted and means the same; plain issue:write cannot delete, and issue:* does not grant the approve scope). " +
          "Does NOT delete the issue. Body: reason (required, max 1000) and assigned_approver_id (optional). Creates a deletion_request (target_type=issue) and returns 202. " +
          "A different PERSON holding issue:delete:approve and an approver role must approve it at POST /deletion-requests/{id}/approve. Audit: issue.delete_requested now, issue.delete on approval.",
        operationId: "deleteIssue",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["reason"], properties: { reason: { type: "string", maxLength: 1000 }, assigned_approver_id: { type: ["string", "null"], format: "uuid" } } } } } },
        responses: {
          "202": { description: "Deletion request created (pending) — { data: deletion_request }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Missing issue:delete:request (forbidden_scope), or no recorded owner (no_principal)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "duplicate_deletion_request — a request is already pending; or validation error (reason required)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/clashes": {
      get: {
        tags: ["clashes"],
        summary: "List clashes",
        description: "scope: clash:read",
        operationId: "listClashes",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": { description: "Paginated clash list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["clashes"],
        summary: "Create a clash record",
        description: "scope: clash:write",
        operationId: "createClash",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: {
          "201": { description: "Clash created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/clashes/{id}": {
      get: {
        tags: ["clashes"],
        summary: "Get a clash",
        description: "scope: clash:read",
        operationId: "getClash",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Clash", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["clashes"],
        summary: "Update a clash",
        description: "scope: clash:write",
        operationId: "updateClash",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: {
          "200": { description: "Updated clash", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["clashes"],
        summary: "Delete a clash",
        description: "scope: clash:write",
        operationId: "deleteClash",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/resources": {
      get: {
        tags: ["resources"],
        summary: "List resource members",
        description: "scope: resource:read",
        operationId: "listResources",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": { description: "Paginated resource member list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["resources"],
        summary: "Create a resource member",
        description: "scope: resource:write",
        operationId: "createResource",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, role: { type: "string" }, cost_rate: { type: "number" }, capacity_hours_per_week: { type: "number" } } } } } },
        responses: {
          "201": { description: "Resource member created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/resources/{id}": {
      get: {
        tags: ["resources"],
        summary: "Get a resource member",
        description: "scope: resource:read",
        operationId: "getResource",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Resource member", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["resources"],
        summary: "Update a resource member",
        description: "scope: resource:write",
        operationId: "updateResource",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, cost_rate: { type: "number" }, capacity_hours_per_week: { type: "number" } } } } } },
        responses: {
          "200": { description: "Updated resource member", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["resources"],
        summary: "Delete a resource member",
        description:
          "scope: resource:write. Hour logging was removed (decision 18) but its history is kept in the database: a member " +
          "who has ANY retained timesheet submission (submitted, approved or rejected) still cannot be deleted: 422 has_timesheet_records " +
          "— their approval history would be erased with them.",
        operationId: "deleteResource",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "The member has retained timesheet records (has_timesheet_records)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/allocations": {
      get: {
        tags: ["allocations"],
        summary: "List allocations",
        description: "scope: resource:read",
        operationId: "listAllocations",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": { description: "Paginated allocation list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["allocations"],
        summary: "Create an allocation",
        description: "scope: resource:write. Triggers over-allocation clash detection. allocation_pct is 0..500 or omitted (null is 422). If the detector fails the allocation is still saved (201) and the response carries warnings: string[] (\"The allocation was saved, but over-allocation detection failed; clashes for this member may be out of date.\"). A clash already in investigating counts as open (no duplicate is raised); clashes the detector closes are audited as clash.auto_resolve. Send Idempotency-Key to make a retry return the first allocation.",
        operationId: "createAllocation",
        parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["member_id"], properties: { member_id: { type: "string", format: "uuid" }, project_id: { type: "string", format: "uuid" }, task_id: { type: "string", format: "uuid" }, allocation_pct: { type: "number" }, hours: { type: "number" }, window_start: { type: "string", format: "date-time" }, window_end: { type: "string", format: "date-time" } } } } } },
        responses: {
          "201": { description: "Allocation created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/allocations/{id}": {
      get: {
        tags: ["allocations"],
        summary: "Get an allocation",
        description: "scope: resource:read",
        operationId: "getAllocation",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Allocation", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["allocations"],
        summary: "Update an allocation",
        description: "scope: resource:write. Re-runs over-allocation detection. allocation_pct is 0..500 (null is 422). The response may carry warnings: string[] when detection failed after the save.",
        operationId: "updateAllocation",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { member_id: { type: "string", format: "uuid" }, project_id: { type: "string", format: "uuid" }, task_id: { type: "string", format: "uuid" }, allocation_pct: { type: "number" }, hours: { type: "number" }, window_start: { type: "string", format: "date-time" }, window_end: { type: "string", format: "date-time" } } } } } },
        responses: {
          "200": { description: "Updated allocation", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["allocations"],
        summary: "Delete an allocation",
        description: "scope: resource:write",
        operationId: "deleteAllocation",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/budget": {
      get: {
        tags: ["budget"],
        summary: "Get budget summary for a project",
        description: "scope: budget:read. Returns planned, committed, actual (expenses only; hour logging was removed, decision 18), variance, burn_pct, estimate_to_complete, committed_open and forecast_method. The forecast object is { method, estimate_to_complete, committed, committed_open, eac, eac_cpi, eac_bottom_up, etc, vac }. committed_open is commitments not yet invoiced; null means the read uses committed_amount: eac_cpi = budget / CPI (null until money is spent); eac_bottom_up = spent (expenses only) + committed + estimate_to_complete (null while no estimate exists); eac follows the method and is null when that method cannot be computed (no silent fallback); etc = eac minus spent; vac = budget minus eac. Committed is never double counted.",
        operationId: "getProjectBudget",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Budget summary", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      put: {
        tags: ["budget"],
        summary: "Upsert budget for a project",
        description:
          "scope: budget:write. States the whole budget: planned_amount is required, committed_amount and currency fall " +
          "back to 0 / USD when omitted. actual_amount, contingency_reserve and management_reserve are stored when sent " +
          "and left as they were when not. estimate_to_complete (number or null), committed_open (number or null) and forecast_method (cpi | bottom_up) may also be sent; on a locked project they need no change request, because they move the forecast and not the approved plan. For a partial change use PATCH.",
        operationId: "upsertProjectBudget",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["planned_amount"], properties: { planned_amount: { type: "number", minimum: 0 }, committed_amount: { type: "number", minimum: 0, default: 0 }, currency: { type: "string", default: "USD" }, actual_amount: { type: "number", minimum: 0 }, contingency_reserve: { type: "number", minimum: 0 }, management_reserve: { type: "number", minimum: 0 }, estimate_to_complete: { type: ["number", "null"], minimum: 0 }, committed_open: { type: ["number", "null"], minimum: 0 }, forecast_method: { type: "string", enum: ["cpi", "bottom_up"] } } } } } },
        responses: {
          "200": { description: "Budget upserted", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["budget"],
        summary: "Partially update the budget for a project",
        description:
          "scope: budget:write. Truly partial: ONLY the columns named in the body are written; nothing is defaulted, so " +
          "omitting committed_amount or currency leaves the stored values alone. Send at least one of planned_amount, " +
          "committed_amount, currency, actual_amount, contingency_reserve, management_reserve, estimate_to_complete, forecast_method (an empty body is a 422). Sending only estimate_to_complete, committed_open or forecast_method on a locked project needs no change request; any other field does. " +
          "On a project with no budget row yet it creates one holding what was sent, with the column defaults for the rest.",
        operationId: "patchProjectBudget",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", minProperties: 1, properties: { planned_amount: { type: "number", minimum: 0 }, committed_amount: { type: "number", minimum: 0 }, currency: { type: "string" }, actual_amount: { type: "number", minimum: 0 }, contingency_reserve: { type: "number", minimum: 0 }, management_reserve: { type: "number", minimum: 0 }, estimate_to_complete: { type: ["number", "null"], minimum: 0 }, committed_open: { type: ["number", "null"], minimum: 0 }, forecast_method: { type: "string", enum: ["cpi", "bottom_up"] } } } } } },
        responses: {
          "200": { description: "Budget updated", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error, or nothing to change", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/expenses": {
      get: {
        tags: ["budget"],
        summary: "List expenses for a project",
        description: "scope: budget:read",
        operationId: "listProjectExpenses",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": { description: "Paginated expense list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["budget"],
        summary: "Create an expense for a project",
        description: "scope: budget:write. incurred_on is optional and defaults to today (UTC). Send Idempotency-Key to make a retry return the first expense.",
        operationId: "createExpense",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }, { $ref: "#/components/parameters/IdempotencyKey" }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["description", "amount"], properties: { description: { type: "string" }, amount: { type: "number", minimum: 0 }, category: { type: "string" }, incurred_on: { type: "string", format: "date" } } } } } },
        responses: {
          "201": { description: "Expense created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/expenses/{id}": {
      delete: {
        tags: ["budget"],
        summary: "Request expense deletion (maker step)",
        description:
          "scope: expense:delete:request (new in wave 4; it used to need budget:write). Does NOT delete the expense: an expense is a money record. " +
          "Body: reason (required, max 1000) and assigned_approver_id (optional). Creates a deletion_request (target_type=expense) and returns 202. " +
          "A different PERSON holding expense:delete:approve and an approver role must approve it at POST /deletion-requests/{id}/approve. Audit: expense.delete_requested now, expense.delete on approval. The request is `normal` tier (a manager approves). When the absolute amount is at or above the workspace `currency_threshold` (default 50,000) it is `high_risk` and only an admin approves it, as for a project; the raise is audited as deletion_request.tier_raised. The tier is in the `tier` field of the 202 response.",
        operationId: "deleteExpense",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["reason"], properties: { reason: { type: "string", maxLength: 1000 }, assigned_approver_id: { type: ["string", "null"], format: "uuid" } } } } } },
        responses: {
          "202": { description: "Deletion request created (pending) — { data: deletion_request }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Missing expense:delete:request (forbidden_scope), or no recorded owner (no_principal)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "duplicate_deletion_request — a request is already pending; or validation error (reason required)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/deletion-requests": {
      get: {
        tags: ["deletion-requests"],
        summary: "List deletion requests",
        description: "scope: task:read or audit:read. Optional ?status filter (pending|approved|rejected|committed|withdrawn). Covers every target_type: task, project, risk, issue, expense, document and milestone (wave 4). Each row carries tier and approval_deadline_at; an expense deletion can be high_risk.",
        operationId: "listDeletionRequests",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
          { name: "status", in: "query", schema: { type: "string", enum: ["pending", "approved", "rejected", "committed", "withdrawn"] } },
        ],
        responses: {
          "200": { description: "Paginated deletion request list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
    },
    "/deletion-requests/{id}/approve": {
      post: {
        tags: ["deletion-requests"],
        summary: "Approve (checker step) — executes the deletion",
        description:
          "scope: task:delete:approve for target_type=task, project:delete:approve for project, risk:delete:approve, " +
          "issue:delete:approve, expense:delete:approve, document:delete:approve or milestone:delete:approve for the others " +
          "(per-type gate, resolved from the loaded request; a wildcard scope never grants it). Reject uses the same approve scope. " +
          "Withdraw uses the matching <entity>:delete:request scope. Four-eyes " +
          "compares PEOPLE: the approver must be a different person from the requester — a token counts as " +
          "the user who minted it, so you cannot approve with your own token what you (or any of your tokens) " +
          "requested (403, code self_approval); a token with no recorded owner can never approve (403, code " +
          "no_principal). The caller must also be an admin or manager — a token is judged by its creator's current role (403, " +
          "code role_not_permitted, 'Only managers and admins can approve', or a tier message such as 'Only admins can approve a high-risk request.'). Optional body { note }: the approver's note, recorded in the audit row of the " +
          "decision (an empty body is fine). " +
          "Dispatches by target_type to the matching atomic commit RPC " +
          "(nopm_commit_task_deletion / nopm_commit_project_deletion, and the wave-4 risk, issue, expense, document and milestone commits) — deletes the target and commits " +
          "the request in one transaction. " +
          "An approved document is on the manager tier like any other document: a manager or admin other than the requester approves it. A refusal names the tier's role ('Only admins can approve a high-risk request.'). An expense deletion at or above currency_threshold is high_risk and only an admin approves it. Approving a PROJECT deletion closes every pending request on that project's children as withdrawn, with closed_reason parent_deleted. " +
          "For target_type=project, also 422s project_locked if the project's schedule was frozen" +
          "after the deletion was requested, and 422s children_changed if the project gained records (tasks, " +
          "milestones, risks, ...) after the request was raised — the request no longer describes what would be " +
          "deleted, so reject or withdraw it and raise a new one. For target_type=task, 422s target_changed if the task " +
          "was edited after the request was raised (the request stored the task as it was).",
        operationId: "approveDeletionRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  note: { type: ["string", "null"], maxLength: 1000, description: "The approver's note, recorded in the audit row (UC-12)" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Deletion committed — { data: { committed: true } }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Missing the per-type approve scope (forbidden_scope); the caller (or the person behind the token) is not an admin or manager (role_not_permitted, 'Only managers and admins can approve'); the approver is the same person as the requester (self_approval); or the token has no recorded owner (no_principal)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Request already decided (already_decided); the project is locked (project_locked — target_type=project, schedule frozen since the request was made); the project gained records since the request (children_changed; for a milestone, the task count moved); a project-locked milestone (project_locked, which closes the request); the task was edited since the request (target_changed); the target was already deleted, e.g. by a cascade (target_gone — the request is closed as withdrawn); or validation error (note too long)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/deletion-requests/{id}/reject": {
      post: {
        tags: ["deletion-requests"],
        summary: "Reject a pending deletion request (checker step)",
        description: "scope: task:delete:approve for task requests, project:delete:approve for project requests (per-type gate; a wildcard scope never grants it). Four-eyes compares PEOPLE: the decider must be a different person from the requester. Self-rejection by the SAME actor returns 422 (code self_approval); the same person through ANOTHER identity (e.g. a token they minted) returns 403 (code self_approval); a token with no recorded owner returns 403 (code no_principal). A maker cancels their own request via /withdraw instead. Admins and managers only (403, code role_not_permitted, 'Only managers and admins can approve', or a tier message such as 'Only admins can approve a high-risk request.').",
        operationId: "rejectDeletionRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string", maxLength: 1000 } } } } } },
        responses: {
          "200": { description: "Request rejected — { data: { rejected: true } }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Missing the per-type approve scope (forbidden_scope); not an admin or manager (role_not_permitted); the same person as the requester through another identity (self_approval); or no recorded owner (no_principal)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Request already decided (already_decided), self-rejection by the same actor (self_approval), or validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/deletion-requests/{id}/withdraw": {
      post: {
        tags: ["deletion-requests"],
        summary: "Withdraw your own pending deletion request (maker step)",
        description: "scope: task:delete:request for a task request, project:delete:request for a project request, and <entity>:delete:request for risk, issue, expense, document and milestone requests (per-type maker gate). Only the ORIGINAL requester may withdraw: the same actor, or the same PERSON through another identity (the human behind a token or assistant that raised it can cancel it from their session). Only while the request is pending. Cancels the request without a checker decision — the one self-act four-eyes permits; audited as deletion_request.withdrawn.",
        operationId: "withdrawDeletionRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Request withdrawn", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Caller is neither the original requester nor the person behind it, or lacks the per-type maker scope", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Request already decided (already_decided)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/audit": {
      get: {
        tags: ["audit"],
        summary: "Query the immutable audit log",
        description:
          "scope: audit:read. Filters: ?target_type, ?target_id, ?action, ?actor_id, " +
          "?project_id (uuid; the project itself and every record whose audited row names it), ?person_id (uuid; that person's own actions and actions made through a token they own), " +
          "?kinds (comma list of task,risk,issue,change_request,decision,document,project), ?until (ISO 8601 timestamp, exclusive upper bound that pairs with since; 422 when malformed), " +
          "?channel (R-82: one of ui|api|cli|mcp|assistant|lark|github, unrecognized values ignored). " +
          "WAVE 4: each row also carries prev_hash, row_hash and chain_seq (the hash chain; check it with GET /audit/verify). A GitHub work event is recorded with channel github, via_connector_id and the delivery id. " +
          "R-85 cursor params for tailing the log: ?since (ISO 8601 timestamp, rows with " +
          "created_at >= since; 422 if unparsable), ?after_id (uuid of a row already seen; " +
          "looked up within the caller's workspace and its created_at used as a strict lower " +
          "bound — 404 if the id doesn't exist in this workspace; combine with ?since and both " +
          "are applied), ?order (asc|desc, default desc; 422 otherwise). " +
          "Each row also carries `channel` (the declared/caller-asserted client — provenance " +
          "only, never an authorization input) and `request_id` (a per-request correlation id, " +
          "also echoed on this response as the X-Request-Id header) — both nullable for rows " +
          "written before migration 20260906000042_audit_channel.sql. " +
          "A decision made from a chat card (Lark) is recorded with channel `lark`, plus via_connector_id, " +
          "external_event_id and external_actor_ref (the platform tenant and user ids in it abbreviated, like every other " +
          "audit row here) — all SERVER-DERIVED from the verified connector binding, " +
          "never accepted from X-NoPM-Client (a caller can only DECLARE ui|api|cli|mcp|assistant); ?channel=lark filters " +
          "to the decisions and account links made through the chat connector. The audit rows of connector management " +
          "carry the Lark app id, group chat id and platform user / tenant ids abbreviated, because this stream is " +
          "readable by every workspace member.",
        operationId: "listAuditLog",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 50, minimum: 1, maximum: 100 } },
          { name: "target_type", in: "query", schema: { type: "string" } },
          { name: "target_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "action", in: "query", schema: { type: "string" } },
          { name: "actor_id", in: "query", schema: { type: "string" } },
          { name: "channel", in: "query", schema: { type: "string", enum: ["ui", "api", "cli", "mcp", "assistant", "lark", "github"] } },
          { name: "since", in: "query", schema: { type: "string", format: "date-time" }, description: "R-85: rows with created_at >= since; 422 if unparsable" },
          { name: "after_id", in: "query", schema: { type: "string", format: "uuid" }, description: "R-85: rows with created_at strictly greater than this row's created_at; 404 if the row doesn't exist in this workspace" },
          { name: "order", in: "query", schema: { type: "string", enum: ["asc", "desc"], default: "desc" }, description: "R-85: 422 if not asc|desc" },
        ],
        responses: {
          "200": { description: "Paginated audit log entries", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
          "404": { description: "after_id not found in this workspace", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Unparsable since, invalid order, or malformed after_id", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/audit/verify": {
      get: {
        tags: ["audit"],
        summary: "Verify the audit hash chain (wave 4, tamper evidence)",
        description:
          "scope: admin or manager SESSION only. A token of any scope, a member or a viewer is 403. Recomputes the per-workspace " +
          "audit hash chain (prev_hash, row_hash, chain_seq; migration 0104) and reports whether every row still matches. A row that was " +
          "edited, a row removed from the middle, or a re-ordering is detected: first_bad_id names the first row that does not match. " +
          "Optional query from (ISO 8601 timestamp; 422 when unparsable) checks only rows created at or after it. " +
          "Throttled: one run per workspace per 5 minutes (429 verify_throttled with last_result). Each run checks at most limit rows, the newest window when the chain is longer. " +
          "The check writes exactly one audit row, action audit.verified, whose after holds the result. The chain does not stop a database " +
          "owner who rewrites a row and recomputes every later hash; keep head_hash outside the database to cover that. " +
          "The Trust Center shows the same result as \"Chain verified: n rows, last check <time>\" with a Verify now button.",
        operationId: "verifyAuditChain",
        parameters: [
          { name: "from", in: "query", required: false, schema: { type: "string", format: "date-time" }, description: "Check only rows created at or after this time" },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200000, default: 50000 }, description: "Most rows checked in one run. Above 200000 is 422. first_seq and limit in the result show the window that was checked." },
        ],
        responses: {
          "200": {
            description: "The chain check result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data"],
                  properties: {
                    data: {
                      type: "object",
                      required: ["ok", "checked", "first_bad_id", "first_bad_at", "from", "head_hash", "verified_at"],
                      properties: {
                        ok: { type: "boolean", description: "true when every checked row matches" },
                        checked: { type: "integer", description: "Rows verified" },
                        first_bad_id: { type: ["string", "null"], format: "uuid" },
                        first_bad_at: { type: ["string", "null"], format: "date-time" },
                        from: { type: ["string", "null"], format: "date-time" },
                        head_hash: { type: ["string", "null"], description: "row_hash of the newest row in the workspace; null when the workspace has no audit rows" },
                        verified_at: { type: "string", format: "date-time" },
                        first_seq: { type: ["integer", "null"], description: "chain_seq of the first row checked in this run" },
                        limit: { type: "integer", description: "The row limit this run used" },
                      },
                    },
                  },
                },
              },
            },
          },
          "403": { description: "A token, a member or a viewer (not an admin or manager session)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "from is not a parsable timestamp, or limit is outside 1 to 200000", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "verify_throttled — one run per workspace per 5 minutes. The body carries last_result, the most recent run's result. Retry-After gives the seconds to wait.", headers: { "Retry-After": { schema: { type: "integer" } } }, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "500": { description: "The database check failed. No audit row is written.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/export": {
      get: {
        tags: ["export"],
        summary: "Governed CSV export (L-27 / L-36)",
        description:
          "Requires the entity's read scope (task:read, risk:read, issue:read, clash:read, " +
          "audit:read, program:read, project:read, or change:read). entity=members|tokens|identities (access review, R-132) have no scope: " +
          "an admin or manager SESSION only, 403 for any token, member or viewer. members = role/status/mfa_enabled/removed_at/last role change; " +
          "tokens = label/prefix/scopes/creator/expiry/revoked/last_used_at, never the hash; identities = chat-connector links (profile, provider, linked_at, revoked_at). " +
          "from/to (UTC days, inclusive) apply to EVERY entity on created_at, or updated_at with on=updated where the entity has one (R-133). " +
          "entity=audit also carries principal_id, principal_label, via_connector_id, external_event_id and external_actor_ref, and (wave 4) row_hash as its LAST column. " +
          "entity=risks takes impact_area=a,b (any-of) and exports risk_category and impact_areas. Streams text/csv with Content-Disposition " +
          "nopm-<entity>-<date>.csv (date is server-derived, never from request input). " +
          "entity=change_requests (scope change:read) exports every change request in range, with decision, impact_scope, implemented and evidence columns; on=updated is supported. Wave 4 adds trailing columns tier, is_emergency, retro_due_at, retro_decided_at, retro_outcome and retro_overdue; the retro_* columns are deprecated history for emergencies raised before the retro was retired. " +
          "entity=audit_pack is the audit pack, admin or manager SESSION only (403 for any token, member or viewer). Its PDF cover, and the weekly report HTML, print \"Audit chain head: <hash> at <time> UTC\" (wave 4), the newest row_hash at export time; keep a copy of it outside the database. format=csv (default; one file whose first column section is change_requests, evidence, decisions or approvals_audit) or format=pdf; any other format is 422. The change-request sheet has the columns tier, is_emergency (yes, or blank), retro_due_at, retro_decided_at, retro_outcome and retro_overdue. The retro_* columns are history for emergencies raised before the retro was retired, and retro_overdue is deprecated: it is blank in every row and stays one more release so tooling keyed on the header still works. A change request is in range when raised or decided in range. Each section is capped at 10,000 rows with a TRUNCATED note row. Filename nopm-audit-pack-<date>.csv or .pdf; audited as export.audit_pack. " +
          "Filter/sort params are the SAME ones the entity's list API takes (single source of " +
          "truth, so a filter honored in a list view is always honored the same way in its " +
          "export): tasks accept project_id/assignee_id/status_type/priority/" +
          "due_before/due_after/overdue/q/sort; risks/issues take an OPTIONAL project_id (omitted = every risk/issue in the workspace, " +
          "for cross-project registers) plus status/severity(/priority for issues)/q (title ilike)/sort; projects accept " +
          "rag_status/phase/program_id/q (name ilike)/sort (name|code|rag_status|phase|completion_pct|target_date|created_at); clashes take no " +
          "filters (fixed created_at desc, matching GET /clashes); audit accepts " +
          "target_type/target_id/action/actor_id/channel (R-82)/since/from/to/order (R-85, leniently: an " +
          "unparsable since or unrecognized order is dropped rather than 422ing, unlike GET /audit — " +
          "after_id is NOT supported here, it needs a row lookup only the list route performs); " +
          "programs take no filters (fixed name asc, " +
          "T3 F2c-mini). Capped " +
          "at 10,000 rows — if the true match count exceeds the cap, a final CSV row notes the " +
          "truncation and the server logs it. The export is a governed read but still writes " +
          "exactly one fail-closed audit_log row (action export.csv, target_type=entity, " +
          "after={entity, row_count, filters}) — so exporting the audit log itself is itself " +
          "audited (L-36).",
        operationId: "exportCsv",
        parameters: [
          { name: "entity", in: "query", required: true, schema: { type: "string", enum: ["tasks", "risks", "issues", "clashes", "audit", "programs", "projects", "members", "tokens", "identities", "change_requests", "audit_pack"] } },
          { name: "from", in: "query", schema: { type: "string", format: "date" }, description: "Inclusive UTC start day, every entity (malformed ignored)" },
          { name: "to", in: "query", schema: { type: "string", format: "date" }, description: "Inclusive UTC end day, every entity (malformed ignored)" },
          { name: "on", in: "query", schema: { type: "string", enum: ["created", "updated"], default: "created" }, description: "Which date the range filters; updated applies to tasks|risks|issues|clashes|projects|change_requests only" },
          { name: "format", in: "query", schema: { type: "string", enum: ["csv", "pdf"], default: "csv" }, description: "entity=audit_pack only: csv (default) or pdf" },
          { name: "impact_area", in: "query", schema: { type: "string" }, description: "entity=risks: comma list, any-of (schedule|cost|scope|quality|reputation|compliance)" },
          { name: "project_id", in: "query", schema: { type: "string", format: "uuid" }, description: "Optional filter for entity=tasks|risks|issues (risks/issues: omitted = whole workspace; a project outside the workspace 404s)" },
          { name: "sort", in: "query", schema: { type: "string" }, description: "field:asc|desc — only for entity=tasks|risks|issues|projects (whitelisted per entity, same as the list API)" },
          { name: "assignee_id", in: "query", schema: { type: "string", format: "uuid" }, description: "entity=tasks" },
          { name: "status_type", in: "query", schema: { type: "string" }, description: "entity=tasks" },
          { name: "priority", in: "query", schema: { type: "string" }, description: "entity=tasks|issues" },
          { name: "due_before", in: "query", schema: { type: "string", format: "date" }, description: "entity=tasks" },
          { name: "due_after", in: "query", schema: { type: "string", format: "date" }, description: "entity=tasks" },
          { name: "overdue", in: "query", schema: { type: "string", enum: ["true"] }, description: "entity=tasks" },
          { name: "q", in: "query", schema: { type: "string" }, description: "entity=tasks|projects (name ilike) | risks|issues (title ilike)" },
          { name: "status", in: "query", schema: { type: "string" }, description: "entity=risks|issues" },
          { name: "rag_status", in: "query", schema: { type: "string", enum: ["not_started", "red", "amber", "green", "complete"] }, description: "entity=projects" },
          { name: "phase", in: "query", schema: { type: "string" }, description: "entity=projects" },
          { name: "program_id", in: "query", schema: { type: "string", format: "uuid" }, description: "entity=projects" },
          { name: "severity", in: "query", schema: { type: "string" }, description: "entity=risks|issues" },
          { name: "target_type", in: "query", schema: { type: "string" }, description: "entity=audit" },
          { name: "target_id", in: "query", schema: { type: "string" }, description: "entity=audit" },
          { name: "action", in: "query", schema: { type: "string" }, description: "entity=audit" },
          { name: "actor_id", in: "query", schema: { type: "string" }, description: "entity=audit" },
          { name: "channel", in: "query", schema: { type: "string", enum: ["ui", "api", "cli", "mcp", "assistant", "lark"] }, description: "entity=audit (R-82)" },
          { name: "since", in: "query", schema: { type: "string", format: "date-time" }, description: "entity=audit (R-85, lenient — a bad value is dropped, not 422)" },
          { name: "from", in: "query", schema: { type: "string", format: "date" }, description: "entity=audit — first UTC day to include (created_at >= from 00:00Z); a day-granular companion to since, both narrow when both are given. Lenient — a malformed date is dropped, not 422" },
          { name: "to", in: "query", schema: { type: "string", format: "date" }, description: "entity=audit — last UTC day to include (created_at < the next day 00:00Z). Lenient — a malformed date is dropped, not 422" },
          { name: "order", in: "query", schema: { type: "string", enum: ["asc", "desc"] }, description: "entity=audit (R-85, lenient — an unrecognized value is dropped, not 422)" },
        ],
        responses: {
          "200": { description: "CSV file (RFC 4180, CRLF, BOM, header always present), or a PDF for entity=audit_pack&format=pdf", content: { "text/csv": { schema: { type: "string" } }, "application/pdf": { schema: { type: "string", format: "binary" } } } },
          "403": { description: "Forbidden — missing the entity's read scope", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Invalid/missing entity, an invalid sort field, or a format other than csv or pdf", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "project_id not found in this workspace (entity=risks|issues)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/mfa": {
      get: {
        tags: ["auth"],
        summary: "Get MFA status for the current user",
        description: "scope: user session only. Returns { enabled, enrolled, satisfied }; satisfied is true once the MFA challenge cookie for this session is valid (R-91). Also required (admins and managers), in_grace, grace_ends_at, grace_days_left and must_enrol: two-step is required for admins and managers after a 14-day grace period that starts at release (or when they become admin/manager); after it the console sends them to /settings?mfa=required. The demo login is exempt; tokens are unaffected (owner decision 22).",
        operationId: "getMfaStatus",
        responses: {
          "200": { description: "MFA status", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "401": { description: "Not a user session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/mfa/challenge": {
      post: {
        tags: ["auth"],
        summary: "Verify a TOTP code or backup code after password sign-in (R-91)",
        description: "scope: user session only. Exempt from the MFA-challenge gate itself. Rate-limited: 10 attempts / 5 min / account (shared with verify and disable). A TOTP code already used is refused (replay guard); failures are audited as auth.mfa.verify_failed. On success sets the signed HttpOnly nopm_mfa cookie (max 12h, never outliving the session).",
        operationId: "challengeMfa",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string", description: "6-digit TOTP code, or a 32-char backup code (consumed on use)" } } } } } },
        responses: {
          "200": { description: "Challenge passed; nopm_mfa cookie set", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Invalid code, or MFA not enabled for this account", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "Too many attempts (10 / 5 min per account, shared with verify and disable); Retry-After header gives the seconds", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/mfa/enroll": {
      post: {
        tags: ["auth"],
        summary: "Begin TOTP enrollment — returns secret and otpauth URI",
        description: "scope: user session only. Refused while two-step is already on (409, code mfa_already_enabled, 'Two-step is already on. Turn it off first.'), unless a two-step challenge was passed in the last 10 minutes (re-enrol over a live factor). The shared demo login gets 403 demo_restricted.",
        operationId: "enrollMfa",
        responses: {
          "200": { description: "Enrollment started (secret + otpauth)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "409": { description: "Two-step is already on (code mfa_already_enabled)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/mfa/verify": {
      post: {
        tags: ["auth"],
        summary: "Confirm TOTP code, enable MFA, receive backup codes",
        description: "scope: user session only. The shared demo login gets 403 demo_restricted.",
        operationId: "verifyMfa",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string", description: "6-digit TOTP code" } } } } } },
        responses: {
          "200": { description: "MFA enabled; backup codes returned once", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Invalid code", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/mfa/disable": {
      post: {
        tags: ["auth"],
        summary: "Disable MFA and clear TOTP secret",
        description: "scope: user session only. While two-step is on, the body must carry { code }: a current TOTP code or an unused backup code. Instead of { code } the body may rely on a two-step challenge passed in the last 10 minutes. The shared demo login gets 403 demo_restricted. A wrong or missing code is 422 and audited as auth.mfa.disable_failed. A TOTP code can be used only once (replays are refused). Verify, challenge and disable share one budget of 10 attempts / 5 min per account (429 with Retry-After).",
        operationId: "disableMfa",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string", minLength: 6, maxLength: 64, description: "Current 6-digit TOTP code, or an unused backup code" } } } } } },
        responses: {
          "200": { description: "MFA disabled", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Wrong or missing code (audited auth.mfa.disable_failed)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "Too many attempts (10 / 5 min per account); Retry-After header gives the seconds", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/signout": {
      post: {
        tags: ["auth"],
        summary: "Sign out the current session",
        description: "No auth required. Clears the server-side Supabase cookie session. Always succeeds. A signed-in sign-out is audited as auth.signout.",
        security: [],
        operationId: "signOut",
        responses: {
          "200": { description: "Signed out", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
        },
      },
    },
    "/auth/demo-login": {
      post: {
        tags: ["auth"],
        summary: "One-click demo login (R-53)",
        description:
          "No auth required. Signs in with the pre-seeded demo account (credentials in server-only env vars DEMO_EMAIL / DEMO_PASSWORD) and redirects to /dashboard. " +
          "Failures depend on WHO is calling. A browser navigation (the landing page's form post sends Accept: text/html) " +
          "is never left on a page of raw JSON: every failure is a 302 back to /login?error=<code>, which the login page " +
          "explains — demo_unconfigured when this deployment has no DEMO_EMAIL / DEMO_PASSWORD, demo_unavailable when the " +
          "demo account rejects the sign-in (for example during a reseed) or the auth host cannot be reached. Programmatic " +
          "callers (curl, agents — no text/html in Accept) keep the JSON contract: 503 { error } when the demo account is " +
          "not configured, and 302 to /login?error=demo_unavailable when the sign-in fails.",
        security: [],
        operationId: "demoLogin",
        responses: {
          "302": { description: "Redirect to /dashboard (session cookies set); or, on failure, to /login?error=demo_unavailable | demo_unconfigured (see the description for which callers get which)", headers: { Location: { schema: { type: "string" } } } },
          "503": { description: "Demo account not configured on this deployment — programmatic callers only (a browser navigation is redirected to /login?error=demo_unconfigured instead)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/timeline": {
      get: {
        tags: ["system"],
        summary: "Portfolio timeline graph",
        description: "scope: project:read. Returns the full governed timeline graph for the workspace (projects, milestones, tasks, risks, issues). projectDependencies lists project-to-project dependencies, and edges with kind dependency are milestone-to-milestone (label = dependency kind). Same-project task edges are unchanged.",
        operationId: "getTimeline",
        responses: {
          "200": { description: "Timeline graph", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Forbidden", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/metrics/time-in-status": {
      get: {
        tags: ["system"],
        summary: "Per-task status-span history (flow metrics)",
        description:
          "scope: task:read. Read aggregate over the workspace's task audit trail — returns, per matching task, its ordered status_type spans (entered_at/exited_at/hours), the final span left open against now. ?task_id or ?project_id narrow the task set (no match returns an empty array, never 404). ?date_from/?date_to (YYYY-MM-DD) bound the entered_at of returned spans, not the task set. ?limit caps how many tasks are considered when neither task_id nor project_id narrows the set (default 50, max 100). Unknown query params are rejected with 422.",
        operationId: "getTimeInStatus",
        parameters: [
          { name: "task_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "project_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "date_from", in: "query", schema: { type: "string", format: "date" } },
          { name: "date_to", in: "query", schema: { type: "string", format: "date" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 50, minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": {
            description: "Per-task time-in-status spans",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } },
          },
          "403": { description: "Forbidden", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation failed (unknown query param, bad enum/format)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/search": {
      get: {
        tags: ["system"],
        summary: "Full-workspace record search",
        description: "scope: project:read. Case-insensitive search across projects, tasks, programs, sprints, risks, issues, clashes, documents, change_requests, and decisions. ?q=<query> (min 1 char). Returns up to 30 results.",
        operationId: "search",
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string", minLength: 1 }, description: "Search query" },
        ],
        responses: {
          "200": { description: "Search results (SearchResult[])", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Forbidden", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/notifications": {
      get: {
        tags: ["notifications"],
        summary: "List notifications for the current user",
        description: "scope: notification:read. Optional ?unread=1 to filter unread only.",
        operationId: "listNotifications",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
          { name: "unread", in: "query", schema: { type: "string", enum: ["1"] }, description: "Pass 1 to return only unread notifications" },
        ],
        responses: {
          "200": { description: "Paginated notification list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
          "403": { description: "Forbidden", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/notifications/{id}": {
      patch: {
        tags: ["notifications"],
        summary: "Mark a notification as read",
        description: "scope: notification:read. Idempotent — no-op if already read.",
        operationId: "markNotificationRead",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Notification (read)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/notifications/read-all": {
      post: {
        tags: ["notifications"],
        summary: "Mark all unread notifications as read",
        description: "scope: notification:read. Idempotent.",
        operationId: "markAllNotificationsRead",
        responses: {
          "200": { description: "{ updated: number }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
        },
      },
    },
    "/assistant/credentials": {
      get: {
        tags: ["assistant"],
        summary: "Get AI assistant credential status",
        description: "scope: assistant:read. Session-user only. Never returns the key. Returns connected status, provider, model, and demoAvailable flag.",
        operationId: "getAssistantCredentials",
        responses: {
          "200": { description: "Credential status", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Token actors not allowed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      put: {
        tags: ["assistant"],
        summary: "Store or replace an AI assistant credential",
        description: "scope: assistant:write. Session-user only. API key is encrypted at rest and never returned.",
        operationId: "putAssistantCredentials",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["provider", "apiKey", "model"], properties: { provider: { type: "string" }, apiKey: { type: "string" }, model: { type: "string" } } } } } },
        responses: {
          "200": { description: "Credential stored", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["assistant"],
        summary: "Remove the stored AI assistant credential",
        description: "scope: assistant:write. Session-user only.",
        operationId: "deleteAssistantCredentials",
        responses: {
          "204": { description: "Deleted" },
          "403": { description: "Token actors not allowed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/assistant/chat": {
      post: {
        tags: ["assistant"],
        summary: "Send a message to the AI assistant",
        description: "Session-user only. Runs the agentic assistant loop and returns the reply plus any actions taken. The assistant works with a short-lived (10 min) ephemeral token that is revoked on every path (audited assistant.token.mint / assistant.token.revoke) and has no approve tool. On the shared demo key: 429 with Retry-After when the demo quota is spent (per-IP cap 8/h plus a shared cap), 503 demo_quota_unavailable if the quota store cannot be read (fails closed), 503 misconfigured when no model key is set. A streamed error event may carry code and retry_after_seconds. The fallback reply lists the actions already done.",
        operationId: "assistantChat",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["message"], properties: { message: { type: "string" }, history: { type: "array", items: { type: "object", required: ["role", "content"], properties: { role: { type: "string", enum: ["user", "assistant"] }, content: { type: "string" } } } } } } } } },
        responses: {
          "200": { description: "{ reply, actions, usedDemoKey }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Token actors not allowed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "Demo quota spent (Retry-After header)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "503": { description: "demo_quota_unavailable or misconfigured", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/assistant/conversations": {
      get: {
        tags: ["assistant"],
        summary: "List the caller's assistant conversations",
        description: "Session-user only. scope: assistant:read. Returns the signed-in user's conversations, newest first.",
        operationId: "listAssistantConversations",
        responses: {
          "200": { description: "Conversation list", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
        },
      },
    },
    "/assistant/conversations/{id}": {
      get: {
        tags: ["assistant"],
        summary: "Get an assistant conversation with its messages",
        description: "Session-user only. scope: assistant:read. Ownership-checked (404 if not the caller's).",
        operationId: "getAssistantConversation",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "{ conversation, messages }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/documents": {
      get: {
        tags: ["documents"],
        summary: "List documents",
        description: "scope: document:read. Optional filters: ?project_id, ?folder, ?status, ?doc_type, ?change_request_id.",
        operationId: "listDocuments",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
          { name: "project_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "folder", in: "query", schema: { type: "string" } },
          { name: "status", in: "query", schema: { type: "string" } },
          { name: "doc_type", in: "query", schema: { type: "string" } },
          { name: "change_request_id", in: "query", schema: { type: "string", format: "uuid" }, description: "Only documents linked to this change request (evidence)" },
        ],
        responses: {
          "200": { description: "Paginated document list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["documents"],
        summary: "Create a document",
        description: "scope: document:write. Auto-assigns a DOC-NNN reference_id (numbers are never reused). Text limits: long text 10,000 chars, body 100,000, external_url 2,000 (422). Evidence fields are optional: change_request_id (a change request in the SAME project), evidence_type, evidence_result (needs evidence_type), tested_by_label, tested_at and evidence_note. Evidence without a change request is 422 evidence_needs_change_request; a change request in another project is 422 evidence_link_invalid; one outside the workspace is 422 invalid_reference.",
        operationId: "createDocument",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["title", "doc_type"], properties: { title: { type: "string" }, doc_type: { type: "string" }, project_id: { type: "string", format: "uuid" }, folder: { type: "string" }, status: { type: "string" }, summary: { type: "string" }, body: { type: "string" }, change_request_id: { type: ["string", "null"], format: "uuid", description: "Change request in the SAME project (422 invalid_reference if not in the workspace, 422 evidence_link_invalid if the project differs). null clears all evidence fields." }, evidence_type: { type: ["string", "null"], enum: ["test_result", "uat_signoff", "deploy_record", "screenshot", "other", null] }, evidence_result: { type: ["string", "null"], enum: ["pass", "fail", "partial", "n/a", null], description: "Needs evidence_type (422)." }, tested_by_label: { type: ["string", "null"], minLength: 1, maxLength: 200, description: "Defaults to the caller label when evidence is first recorded." }, tested_at: { type: ["string", "null"], format: "date-time", description: "Defaults to now when evidence is first recorded." }, evidence_note: { type: ["string", "null"], maxLength: 5000 }, external_url: { type: "string" }, owner_id: { type: "string", format: "uuid" } } } } } },
        responses: {
          "201": { description: "Document created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/documents/{id}": {
      get: {
        tags: ["documents"],
        summary: "Get a document",
        description: "scope: document:read",
        operationId: "getDocument",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Document", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["documents"],
        summary: "Update a document",
        description: "scope: document:write. Bumps version when body changes.",
        operationId: "updateDocument",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" }, doc_type: { type: "string" }, project_id: { type: "string", format: "uuid" }, folder: { type: "string" }, status: { type: "string" }, summary: { type: "string" }, body: { type: "string" }, change_request_id: { type: ["string", "null"], format: "uuid", description: "Change request in the SAME project (422 invalid_reference if not in the workspace, 422 evidence_link_invalid if the project differs). null clears all evidence fields." }, evidence_type: { type: ["string", "null"], enum: ["test_result", "uat_signoff", "deploy_record", "screenshot", "other", null] }, evidence_result: { type: ["string", "null"], enum: ["pass", "fail", "partial", "n/a", null], description: "Needs evidence_type (422)." }, tested_by_label: { type: ["string", "null"], minLength: 1, maxLength: 200, description: "Defaults to the caller label when evidence is first recorded." }, tested_at: { type: ["string", "null"], format: "date-time", description: "Defaults to now when evidence is first recorded." }, evidence_note: { type: ["string", "null"], maxLength: 5000 }, external_url: { type: "string" }, owner_id: { type: "string", format: "uuid" } } } } } },
        responses: {
          "200": { description: "Updated document", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["documents"],
        summary: "Request document deletion (maker step)",
        description:
          "scope: document:delete:request (new in wave 4; it used to need document:write). Does NOT delete the document. " +
          "Body: reason (required, max 1000) and assigned_approver_id (optional). Creates a deletion_request (target_type=document) and returns 202. " +
          "An approved document is on the manager tier like any other document: any caller with `document:delete:request` may request its deletion and a manager or admin other than the requester approves it. The request is audited (`document.delete_requested`, `deletion_request.approved`). " +
          "On approval the stored file is removed too. A different PERSON holding document:delete:approve and an approver role must approve it at POST /deletion-requests/{id}/approve.",
        operationId: "deleteDocument",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["reason"], properties: { reason: { type: "string", maxLength: 1000 }, assigned_approver_id: { type: ["string", "null"], format: "uuid" } } } } } },
        responses: {
          "202": { description: "Deletion request created (pending) — { data: deletion_request }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Missing document:delete:request (forbidden_scope), or no recorded owner (no_principal)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "duplicate_deletion_request — a request is already pending; or validation error (reason required)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/documents/{id}/file": {
      get: {
        tags: ["documents"],
        summary: "Download document file (redirect to signed URL)",
        description: "scope: document:read. Returns a 302 redirect to a short-lived Supabase Storage signed URL.",
        operationId: "getDocumentFile",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "302": { description: "Redirect to signed download URL" },
          "404": { description: "Not found or no file attached", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["documents"],
        summary: "Record file metadata after a direct-upload",
        description: "scope: document:write. Call after the browser uploads bytes to the signed upload URL. Body: { path, file_name, mime_type, file_size }. path must belong to this document (422 'Storage path does not belong to this document'); file_size 1 byte..25 MiB. Refused on the shared demo login (403 demo_readonly).",
        operationId: "attachDocumentFile",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["path", "file_name", "mime_type", "file_size"], properties: { path: { type: "string" }, file_name: { type: "string" }, mime_type: { type: "string", description: "Declared type. Browser-executable types (html, svg, xml, js) are stored as application/octet-stream; inline-rendered types (pdf, png, jpeg, gif, webp) are verified against the uploaded bytes on attach (422 on mismatch); other types are served as downloads." }, file_size: { type: "integer" } } } } } },
        responses: {
          "200": { description: "Document with file metadata", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation / path error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["documents"],
        summary: "Remove the attached file from a document",
        description: "scope: document:write. Clears the metadata and writes the audit row first, then deletes the storage object.",
        operationId: "removeDocumentFile",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "File removed" },
          "404": { description: "Not found or no file attached", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/documents/{id}/file/sign": {
      post: {
        tags: ["documents"],
        summary: "Mint a signed upload URL for a document file",
        description: "scope: document:write. Returns a short-lived Supabase Storage signed upload URL. Max file size 25 MiB. Refused on the shared demo login (403 demo_readonly).",
        operationId: "signDocumentFileUpload",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["file_name", "mime_type", "file_size"], properties: { file_name: { type: "string" }, mime_type: { type: "string", description: "Declared type. Browser-executable types (html, svg, xml, js) are stored as application/octet-stream; inline-rendered types (pdf, png, jpeg, gif, webp) are verified against the uploaded bytes on attach (422 on mismatch); other types are served as downloads." }, file_size: { type: "integer", description: "Bytes, max 26214400 (25 MiB)" } } } } } },
        responses: {
          "200": { description: "{ signedUrl, token, path }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error or file too large", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/change-requests": {
      get: {
        tags: ["change-requests"],
        summary: "List change requests across the workspace",
        description:
          "scope: change:read. Workspace-wide list of change requests, newest first. Query: project_id (uuid), status (raised | under_review | approved | rejected | deferred | implemented | emergency), page, limit (max 100), view (summary default | full), fields (comma list, allow-list in src/lib/api/views.ts; an unknown field is 422). Wave 4: each row carries tier and is_emergency (summary view too), and full or fields= adds approval_deadline_at, retro_due_at, retro_decided_at and retro_outcome. retro_due_at, retro_decided_at and retro_outcome are deprecated: retro_due_at is null for every new emergency, retro_decided_at is the raise time, and retro_outcome is not_required (new), retired (closed out by migration 0106) or, on old rows, approved | rejected | deferred. A new emergency change request is stored as approved with tier emergency and is_emergency true; status emergency is no longer written (old rows were moved to approved) and stays in the filter only for history.",
        operationId: "listChangeRequests",
        parameters: [
          { name: "project_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "status", in: "query", schema: { type: "string", enum: ["raised", "under_review", "approved", "rejected", "deferred", "implemented", "emergency"] } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
          { name: "view", in: "query", schema: { type: "string", enum: ["summary", "full"], default: "summary" } },
          { name: "fields", in: "query", schema: { type: "string" }, description: "Comma list of columns; an unknown field is 422" },
        ],
        responses: {
          "200": { description: "Paginated change request list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
          "422": { description: "Bad status, project_id, view or fields", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/decisions": {
      get: {
        tags: ["decisions"],
        summary: "List decisions across the workspace",
        description:
          "scope: decision:read. Workspace-wide list of logged decisions, newest first. Query: project_id (uuid), status (proposed | accepted | superseded | rejected), page, limit (max 100), view (summary default | full), fields (comma list, allow-list in src/lib/api/views.ts; an unknown field is 422).",
        operationId: "listDecisions",
        parameters: [
          { name: "project_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "status", in: "query", schema: { type: "string", enum: ["proposed", "accepted", "superseded", "rejected"] } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
          { name: "view", in: "query", schema: { type: "string", enum: ["summary", "full"], default: "summary" } },
          { name: "fields", in: "query", schema: { type: "string" }, description: "Comma list of columns; an unknown field is 422" },
        ],
        responses: {
          "200": { description: "Paginated decision list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
          "422": { description: "Bad status, project_id, view or fields", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/evm": {
      get: {
        tags: ["budget"],
        summary: "Earned-value numbers for a project",
        description:
          "scope: budget:read. Earned-value numbers for one project, computed as the Budget page does. schedule_basis says which basis the schedule figures used: baseline_dates or completion_only. cpi, spi, eac, etc and vac are null when they are undefined. eac_cpi, eac_bottom_up, committed_open and forecast_method (cpi | bottom_up) sit beside eac; committed_open is the commitments figure the bottom-up forecast used; eac, etc and vac follow forecast_method and are null when that method cannot be computed.",
        operationId: "getProjectEvm",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": {
            description: "Earned-value summary",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        project_id: { type: "string", format: "uuid" },
                        currency: { type: "string" },
                        as_of_date: { type: "string", format: "date" },
                        schedule_basis: { type: "string", enum: ["baseline_dates", "completion_only"] },
                        bac: { type: "number" },
                        pv: { type: "number" },
                        ev: { type: "number" },
                        ac: { type: "number" },
                        committed: { type: "number" },
                        cv: { type: "number" },
                        sv: { type: "number" },
                        cpi: { type: ["number", "null"] },
                        spi: { type: ["number", "null"] },
                        eac: { type: ["number", "null"] },
                        eac_cpi: { type: ["number", "null"] },
                        eac_bottom_up: { type: ["number", "null"] },
                        forecast_method: { type: "string", enum: ["cpi", "bottom_up"] },
                        estimate_to_complete: { type: ["number", "null"] },
                        committed_open: { type: ["number", "null"] },
                        etc: { type: ["number", "null"] },
                        vac: { type: ["number", "null"] },
                      },
                    },
                  },
                },
              },
            },
          },
          "404": { description: "Project not found in this workspace", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/change-requests/{id}/implement": {
      post: {
        tags: ["change-requests"],
        summary: "Mark an approved change request implemented",
        description:
          "scope: change:write. Allowed for the requester's person, or any admin or manager. Needs a principal: a token with no recorded owner is 403 no_principal; anyone else is 403 not_requester. Moves an APPROVED request to implemented (an emergency change is already approved when raised, so it can be implemented at once) and stamps implemented_at, implemented_by, implemented_by_type/id/label, implemented_principal_id and implemented_note in one transaction with its audit row change_request.implement (nopm_implement_change_request). implemented_at is never earlier than decided_at. Once only: a repeat is 422 already_implemented and the stamp is never rewritten. Any other status is 422 invalid_transition.",
        operationId: "implementChangeRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { note: { type: ["string", "null"], maxLength: 2000 } } } } } },
        responses: {
          "200": { description: "The implemented change request (status implemented)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not the requester, or an admin or manager (not_requester), or a token with no recorded owner (no_principal)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "invalid_transition (not approved), already_implemented, or a validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/change-requests/{id}/evidence": {
      get: {
        tags: ["change-requests"],
        summary: "List evidence attached to a change request",
        description:
          "scope: document:read. Evidence documents attached to one change request, ordered by tested_at descending (nulls last). Read-only: attach evidence with POST /documents or PATCH /documents/{id} (set change_request_id and the evidence fields; audited as document.create or document.update). Workspace-filtered; 404 when the change request is not in the caller's workspace. Each item carries id, reference_id, title, doc_type, status, version, project_id, change_request_id, evidence_type, evidence_result, tested_by_label, tested_at, evidence_note, external_url, file_name, mime_type, created_at and updated_at.",
        operationId: "listChangeRequestEvidence",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": {
            description: "Evidence documents for the change request (not paginated: limit 200)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { type: "object" } },
                    total: { type: "integer" },
                    page: { type: "integer", enum: [1] },
                    limit: { type: "integer", enum: [200] },
                  },
                },
              },
            },
          },
          "404": { description: "Change request not found in this workspace", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/change-requests": {
      get: {
        tags: ["change-requests"],
        summary: "List change requests for a project",
        description: "scope: change:read",
        operationId: "listProjectChangeRequests",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": { description: "Paginated change request list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["change-requests"],
        summary: "Raise a change request under a project",
        description:
          "scope: change:write. Auto-assigns a CR-NNN reference_id. WAVE 4 (G1, G2, G4): `tier` (routine | normal | high_risk | strategic; default normal) " +
          "asks for an approval tier. routine needs no cost, no schedule impact and no impact_scope (else 422 on tier); the database also lifts a routine request that later gains one to normal. strategic needs an admin (else 403 role_not_permitted). " +
          "The server raises the tier, never lowers it: a cost at or over the workspace threshold makes it high_risk. " +
          "`is_emergency: true` (manager or admin only, else 403 role_not_permitted) commits at once: the request is stored as `approved` with `tier` `emergency` and `is_emergency` true. It needs no approver and no retro decision, and it has no approval deadline. The raise writes the normal `change_request.create` audit row and a `change_request.emergency_commit` row, with the raiser as the actor. A member gets 403 `role_not_permitted`. To raise an emergency the caller needs a user session (a manager or admin) or a token holding the exact `change:decide` scope; `change:*` and `change:write` are not enough, because a wildcard never grants a decide scope. A token without it gets 403 `role_not_permitted` with a message naming the `change:decide` scope. " +
          "The response carries tier, approval_deadline_at, is_emergency and the deprecated retro_due_at (null), retro_decided_at (the raise time) and retro_outcome (not_required). Only `title` is required (category defaults to " +
          "scope, priority to medium, status to raised). `status` may only be raised or under_review: every terminal " +
          "status needs a decider, so approved / rejected / deferred are reached through " +
          "POST /change-requests/{id}/decision, and implemented through POST /change-requests/{id}/implement — sending one at creation is a 422 validation error, never a raw " +
          "database error. A token with no recorded owner cannot raise a change request (403, code no_principal): " +
          "a requester with no person behind it is comparable to nobody, so the same person could then decide their " +
          "own request from a session.",
        operationId: "createChangeRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(createChangeRequestSchema),
        responses: {
          "201": { description: "Change request created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Missing change:write (forbidden_scope), or the token has no recorded owner (no_principal); strategic tier or is_emergency by a role that may not (role_not_permitted)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Project not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error — including a status other than raised | under_review, a routine tier with cost or schedule impact (fields tier), or an assigned approver below the tier's role (invalid_assigned_approver)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/change-requests/{id}": {
      get: {
        tags: ["change-requests"],
        summary: "Get a change request",
        description: "scope: change:read",
        operationId: "getChangeRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Change request", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["change-requests"],
        summary: "Update a change request",
        description:
          "scope: change:write. ONLY THE REQUESTER'S PERSON may edit an open request (the user who raised it, or a token " +
          "that user minted): anyone else — an approver, say — gets 403 code not_requester and must raise a new change " +
          "request, so nobody can rewrite a pending request and then approve what they wrote; a token with no recorded " +
          "owner is 403 no_principal; a legacy request with no recorded requester can be edited by anyone with the scope. " +
          "`status` is NOT updatable here — every status transition goes through the four-eyes " +
          "POST /change-requests/{id}/decision. Editable ONLY while the request is still open (raised / under_review), (an emergency change is committed when raised, so it is decided from the start): once" +
          "decided it is part of the decision record, and editing its impact_cost after approval would rewrite what the " +
          "decider looked at — 422 change_request_decided (raise a new change request instead); the write is a " +
          "compare-and-set on the open statuses, so a decision landing mid-edit wins. Editing a field an approver decides " +
          "on (title, description, category, priority, impact_summary, impact_schedule_days, impact_cost, impact_scope, target_date) " +
          "bumps the request's updated_at — its content version — and retires any approval card already sent, issuing a " +
          "fresh one with the current content, so a tap on the old card can never approve content it did not show. " +
          "Editing raised_at alone re-issues nothing. impact_scope is an optional array (one entry per area, max 6: area, direction, note); editing it on an open request re-issues the approval card the same way.",
        operationId: "updateChangeRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(updateChangeRequestSchema),
        responses: {
          "200": { description: "Updated change request", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not the requester's person (code not_requester), or a token with no recorded owner (code no_principal)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error, or the request is no longer open (code change_request_decided)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["change-requests"],
        summary: "Delete a change request",
        description: "scope: change:write. Only while the request is still open (raised / under_review), and only by the requester's person (the user who raised it, or a token that user minted; anyone else is 403 code not_requester, an ownerless token 403 no_principal): a decided request (approved / rejected / deferred / implemented) is part of the decision record and is never hard-deleted — 422 change_request_decided.",
        operationId: "deleteChangeRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "403": { description: "Not the requester's person (code not_requester), or a token with no recorded owner (code no_principal)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "The request is no longer open (code change_request_decided)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/change-requests/{id}/decision": {
      post: {
        tags: ["change-requests"],
        summary: "Record an approve / reject / defer decision (four-eyes)",
        description:
          "scope: change:decide (a wildcard such as change:* never grants it). The deciding PERSON must differ from the " +
          "requester (four-eyes, compared on the requester's principal — the user, or the user who minted the token that " +
          "raised it — plus the legacy actor checks); a token with no recorded owner can never decide (403, code " +
          "no_principal). Status must be raised or under_review, and the update is a compare-and-set, so two deciders " +
          "racing cannot both win (the loser gets 422 already_decided). rationale is required. APPROVE WHAT YOU SAW " +
          "(opt-in, like every R-90 write): send expected_updated_at — the updated_at of the change request you were " +
          "looking at — and if it was edited since, the decision is refused with 412 (code precondition_failed) instead " +
          "of approving content the decider never saw; omit it and today's behaviour is unchanged. The decision write is " +
          "itself pinned to that version, so an edit landing between the check and the write also fails with 412. A " +
          "decision made from a chat card is always pinned to the version the card was issued for. WAVE 4 (G1, G2, G4): the request's tier sets the least role. Fallback approver (decision D7): in a workspace with fewer than two admins, a manager may decide an admin-level request; the change_request.decide audit row then records fallback_approver true, and the raiser is still barred. An admin decides high_risk and strategic requests, and a manager decides routine and normal ones unless the workspace policy says otherwise (403 role_not_permitted, 'Only admins can approve a high-risk request.' or 'Only admins can approve an emergency request.'). An emergency change cannot be decided: it commits when raised, so approve, reject and defer answer 422 already_decided (the same on the matching chat paths). Admins and managers only, and the tier above can narrow that to admins " +
          "(403, code role_not_permitted, 'Only managers and admins can approve'); the decision, its audit row and the " +
          "status change are one database transaction (nopm_decide_change_request).",
        operationId: "decideChangeRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(decisionActionSchema),
        responses: {
          "200": { description: "Decision recorded (the updated change request)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Self-approval rejected (code self_approval), not an admin or manager (role_not_permitted), token has no recorded owner (no_principal), or missing change:decide (forbidden_scope)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "412": { description: "expected_updated_at no longer matches: the change request was edited (or decided) since you loaded it (code precondition_failed; current_updated_at is included when known). Re-read it and decide again.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Already decided (code already_decided), or validation error (decision/rationale)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/decisions": {
      get: {
        tags: ["decisions"],
        summary: "List decisions for a project",
        description: "scope: decision:read. Filters: source, external_ref (complement seam, R-81 — both exact-match).",
        operationId: "listProjectDecisions",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
          { name: "source", in: "query", schema: { type: "string" }, description: "Exact-match on the system-of-work slug this decision mirrors (e.g. jira)" },
          { name: "external_ref", in: "query", schema: { type: "string" }, description: "Exact-match on the id/key in that external system" },
        ],
        responses: {
          "200": { description: "Paginated decision list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["decisions"],
        summary: "Log a decision under a project",
        description: "scope: decision:write. Auto-assigns a DEC-NNN reference_id (numbers are never reused). Long text is limited to 10,000 chars (422). Optional change_request_id must name a change request in this workspace on the same project (422 invalid_reference); options_structured is an optional list of options with at most one chosen.",
        operationId: "createDecision",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["title", "status"], properties: { title: { type: "string" }, context: { type: "string" }, options: { type: "string" }, decision: { type: "string" }, rationale: { type: "string" }, status: { type: "string" }, decided_at: { type: "string", format: "date-time" }, supersedes: { type: "string", format: "uuid" }, source: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,39}$", description: "System of work this record mirrors (e.g. jira, slack, teams); NoPM is the governed record beside it" }, external_ref: { type: "string", minLength: 1, maxLength: 200 }, change_request_id: { type: ["string", "null"], format: "uuid", description: "A change request in this workspace on the SAME project (422 invalid_reference otherwise). Link it while the decision is proposed, or when recording it." }, options_structured: { type: "array", maxItems: 20, description: "At most one chosen; labels unique (case-insensitive). The free-text options field stays and both are returned.", items: { type: "object", required: ["label"], properties: { label: { type: "string", minLength: 1, maxLength: 200 }, chosen: { type: "boolean", default: false }, note: { type: ["string", "null"], maxLength: 2000 } } } }, external_url: { type: "string", format: "uri", maxLength: 2000 } } } } } },
        responses: {
          "201": { description: "Decision created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/decisions/{id}": {
      get: {
        tags: ["decisions"],
        summary: "Get a decision",
        description: "scope: decision:read",
        operationId: "getDecision",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Decision", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["decisions"],
        summary: "Update a decision",
        description: "scope: decision:write. `supersedes` must name another decision in this workspace; a decision cannot supersede itself (422 validation error on fields[supersedes]). Refused on an accepted or superseded decision, so link change_request_id or structured options while it is proposed.",
        operationId: "updateDecision",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" }, context: { type: "string" }, options: { type: "string" }, decision: { type: "string" }, rationale: { type: "string" }, status: { type: "string" }, decided_at: { type: "string", format: "date-time" }, supersedes: { type: "string", format: "uuid" }, source: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,39}$", description: "System of work this record mirrors (e.g. jira, slack, teams); NoPM is the governed record beside it" }, external_ref: { type: "string", minLength: 1, maxLength: 200 }, change_request_id: { type: ["string", "null"], format: "uuid", description: "A change request in this workspace on the SAME project (422 invalid_reference otherwise). Link it while the decision is proposed, or when recording it." }, options_structured: { type: "array", maxItems: 20, description: "At most one chosen; labels unique (case-insensitive). The free-text options field stays and both are returned.", items: { type: "object", required: ["label"], properties: { label: { type: "string", minLength: 1, maxLength: 200 }, chosen: { type: "boolean", default: false }, note: { type: ["string", "null"], maxLength: 2000 } } } }, external_url: { type: "string", format: "uri", maxLength: 2000 } } } } } },
        responses: {
          "200": { description: "Updated decision", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["decisions"],
        summary: "Delete a decision",
        description: "scope: decision:write. A decision that another decision supersedes cannot be deleted — 422 decision_in_use, naming the superseding decision; remove that link first.",
        operationId: "deleteDecision",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Another decision supersedes this one, or something outside this workspace still references it (code decision_in_use)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/lock": {
      post: {
        tags: ["projects"],
        summary: "Lock a project timeline",
        description: "scope: project:write. Sets is_locked=true, records locked_by/locked_at/lock_reason plus locked_by_actor_type, locked_by_actor_id and locked_by_label (who really locked, including an agent token). Snapshots baseline dates for milestones and tasks if not yet baselined, and captures the project's own baseline_start_date / baseline_target_date from its start_date / target_date where those are still null (an existing project baseline is never overwritten) — the snapshot is taken first, while the project is still open, and the lock and its audit row come last. The project.lock audit row records the project baseline before and after in after.project_baseline ({ before: { start, target }, after: { start, target } }). Locking an already-locked project captures no new baselines (unlock and lock again to do that).",
        operationId: "lockProject",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string" } } } } } },
        responses: {
          "200": { description: "Locked project", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/unlock": {
      post: {
        tags: ["projects"],
        summary: "Unlock a project timeline",
        description: "scope: project:write. Clears is_locked, locked_by, locked_at, lock_reason and locked_by_actor_type/locked_by_actor_id/locked_by_label. reason is REQUIRED (R-83 governed unlock) and is recorded in the audit trail's after payload (unlock_reason), not stored on the row. Unlock stays a single-person act (no four-eyes), but it CANCELS the project's pending_approval and approved rebaselines in the same transaction (status cancelled, terminal; owner decision 2026-10-17, migration 0058) — a sign-off can never be applied to dates edited after it, so a fresh proposal and fresh sign-off are needed. Applied, rejected and draft rebaselines are left alone. The project.unlock audit row's after lists cancelled_rebaselines (ids) and each one also gets a rebaseline.cancelled audit row (reason project_unlocked, plus unlock_reason). Atomic: if the cancellation cannot happen, the project stays locked.",
        operationId: "unlockProject",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["reason"], properties: { reason: { type: "string", minLength: 1, maxLength: 1000 } } } } } },
        responses: {
          "200": { description: "Unlocked project", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/rebaselines": {
      get: {
        tags: ["rebaselines"],
        summary: "List rebaselines for a project",
        description: "scope: project:read",
        operationId: "listProjectRebaselines",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": { description: "Paginated rebaseline list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["rebaselines"],
        summary: "Create a rebaseline request",
        description:
          "scope: project:write. Wave 4: the rebaseline carries tier normal and approval_deadline_at (decided by a manager or admin under the approval policy). If the project is locked, status is pending_approval; otherwise draft (a draft on an " +
          "unlocked project is not awaiting sign-off, and sign-off on it is refused). Proposing is the maker step of the " +
          "rebaseline four-eyes flow, so a token with no recorded owner cannot propose (403, code no_principal): its " +
          "requester principal would be null, comparable to nobody, and the same person could then sign off their own " +
          "proposal. Lifecycle: draft -> pending_approval -> approved -> applied, or pending_approval -> rejected; " +
          "applied and rejected are terminal. A pending_approval or approved rebaseline becomes cancelled (also terminal) when its project is unlocked. " +
          "A project can have only ONE rebaseline waiting for sign-off: a second proposal is 409, code pending_rebaseline_exists, " +
          "'This project already has a rebaseline waiting for sign-off'. Two proposals created at the same moment: the loser gets 409, code rebaseline_version_conflict, " +
          "'Another rebaseline proposal was created at the same moment. Reload and try again.' (distinct from pending_rebaseline_exists).",
        operationId: "createRebaseline",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["reason"], properties: { reason: { type: "string" }, before: { type: "object" }, after: { type: "object" } } } } } },
        responses: {
          "201": { description: "Rebaseline created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Missing project:write (forbidden_scope), or the token has no recorded owner (no_principal)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Project not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/rebaselines/{id}/signoff": {
      post: {
        tags: ["rebaselines"],
        summary: "Cast a signoff vote on a rebaseline (four-eyes)",
        description:
          "scope: rebaseline:approve (a wildcard never grants it). Four-eyes compares PEOPLE: the requester may not sign " +
          "off their own rebaseline, nor can the same person through another identity (a token they minted) — 403, code " +
          "self_approval; the legacy same-user case returns 422 with the same code. The vote is cast by a person: a " +
          "session votes as themselves and a token votes as the user who minted it (one vote per person per " +
          "rebaseline); a token with no recorded owner cannot vote (403, code no_principal). Admins and managers only (403, code " +
          "role_not_permitted, 'Only managers and admins can approve'); when the workspace policy asks for an admin to decide the rebaseline's tier, a manager is refused with 403 role_not_permitted, 'Only admins can approve a high-risk request.'. The vote, the status change and the audit row are one " +
          "transaction (nopm_signoff_rebaseline).",
        operationId: "signoffRebaseline",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(signoffSchema),
        responses: {
          "200": { description: "Signoff recorded; rebaseline status may update ({ signoff, rebaseline })", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin or manager (role_not_permitted), self-signoff by the same person via another identity (self_approval), no recorded owner on the token (no_principal), or missing rebaseline:approve (forbidden_scope)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error; the requester signing off their own rebaseline as the same user (self_approval); or the rebaseline is not pending_approval — a draft, or already approved / rejected / applied / cancelled — so it can no longer be voted on (code rebaseline_not_pending, also returned when a concurrent sign-off decided it first)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/rebaselines/{id}/apply": {
      post: {
        tags: ["rebaselines"],
        summary: "Apply an approved rebaseline (four-eyes)",
        description: "scope: rebaseline:approve (a wildcard never grants it). Only approved rebaselines may be applied. The requester may not apply their own rebaseline — compared on the person, so a token the requester minted is refused too (403, code self_approval; the legacy same-user case is a 422 with the same code); a token with no recorded owner cannot apply (403, code no_principal). Overwrites baseline dates for all milestones and tasks in the project, and moves the project's own baseline_start_date / baseline_target_date to its current start_date / target_date (a project with no dates keeps its baseline). The rebaseline.apply audit row records the project baseline before and after in after.project_baseline ({ before: { start, target }, after: { start, target } }) — it shows in the project's History tab and the Trust Center stream. The baseline snapshot runs first and the status flips to applied only after it succeeds, so a failed snapshot (500) leaves the rebaseline approved and the call can simply be repeated. Admins and managers only (403, code role_not_permitted). The apply is one database transaction (nopm_apply_rebaseline) and is refused if the project is no longer locked (422, code project_not_locked, 'Rebaseline cannot be applied: its project is no longer locked. Lock the project and propose a new rebaseline.').",
        operationId: "applyRebaseline",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Rebaseline applied", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin or manager (role_not_permitted), self-apply by the same person via another identity (self_approval), no recorded owner on the token (no_principal), or missing rebaseline:approve (forbidden_scope)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "The requester applying their own rebaseline as the same user (self_approval); the rebaseline is already applied (code already_applied — also returned to the loser of two concurrent applies); or it is not in status approved — a cancelled rebaseline included (code rule_violation); or the project is no longer locked (code project_not_locked)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/tasks/{id}/dependencies": {
      get: {
        tags: ["tasks"],
        summary: "List dependencies for a task",
        description: "scope: task:read. Returns all predecessor and successor edges for the task.",
        operationId: "listTaskDependencies",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Dependency edges", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["tasks"],
        summary: "Add a task dependency",
        description: "scope: task:write. Guards against self-dependency, duplicates, and circular references. 422 project_locked when the project is locked (a new dependency edge reshapes the schedule graph).",
        operationId: "createTaskDependency",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["predecessor_id"], properties: { predecessor_id: { type: "string", format: "uuid" }, type: { type: "string", enum: ["FS", "SS", "FF", "SF"], default: "FS" }, lag_days: { type: "integer", default: 0 } } } } } },
        responses: {
          "201": { description: "Dependency created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Rule violation (self-dep, duplicate, circular), or project_locked when the project is locked", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["tasks"],
        summary: "Remove a task dependency",
        description: "scope: task:write. Body: { predecessor_id }. 422 project_locked when the project is locked (removing a dependency edge reshapes the schedule graph).",
        operationId: "deleteTaskDependency",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["predecessor_id"], properties: { predecessor_id: { type: "string", format: "uuid" } } } } } },
        responses: {
          "204": { description: "Dependency removed" },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "project_locked — the project is locked", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/dependencies": {
      get: {
        tags: ["projects"],
        summary: "List a project's dependencies (both directions)",
        description: "scope: project:read. Each row carries direction (depends_on or depended_on_by), kind (delivery | resource | decision | risk), linked_risk_id, note and other_project { id, code, name, rag_status }. Workspace-filtered; 404 when the project is not in the caller's workspace.",
        operationId: "listProjectDependencies",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Array of dependency rows", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Project not found in this workspace", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["projects"],
        summary: "Declare that this project depends on another project",
        description: "scope: project:write. Body: depends_on_project_id (uuid, required), kind (delivery | resource | decision | risk, required), linked_risk_id (uuid or null; a risk in one of the two projects), note (max 500 characters, or null). Refused: 422 self_dependency; 422 invalid_reference (the other project or the risk is not in this workspace); 422 risk_not_in_projects; 422 circular_dependency (the link would close a loop, of any length and kind); 409 duplicate_dependency (the same pair and kind already exists). Allowed on a locked project, because the locked schedule is not changed. Audited as project.dependency.add. Returns 201 with the row.",
        operationId: "addProjectDependency",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["depends_on_project_id", "kind"], properties: { depends_on_project_id: { type: "string", format: "uuid" }, kind: { type: "string", enum: ["delivery", "resource", "decision", "risk"] }, linked_risk_id: { type: ["string", "null"], format: "uuid" }, note: { type: ["string", "null"], maxLength: 500 } } } } } },
        responses: {
          "201": { description: "The dependency row", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Project not found in this workspace", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "409": { description: "duplicate_dependency (same pair and kind already declared)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error; self_dependency; invalid_reference; risk_not_in_projects; circular_dependency; or cross_workspace (database backstop)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/dependencies/{depId}": {
      delete: {
        tags: ["projects"],
        summary: "Remove a project dependency",
        description: "scope: project:write. Returns 204. 404 when the dependency is not under this project in this workspace. Allowed on a locked project. Audited as project.dependency.remove (before = the row, after = null).",
        operationId: "removeProjectDependency",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "depId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "204": { description: "Removed" },
          "404": { description: "Dependency not found under this project in this workspace", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/contingency": {
      get: {
        tags: ["projects"],
        summary: "Is this project waiting on a red project?",
        description: "scope: project:read. Transitive over project dependencies (depth at most 5, cycle-safe). Returns declared_rag, worst_dependency_rag, contingent_on_red and the chain of projects from this project to the red one (empty when not contingent), plus depth_capped. Advisory only: it never changes a declared RAG.",
        operationId: "getProjectContingency",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Contingency summary", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Project not found in this workspace", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/trend": {
      get: {
        tags: ["budget"],
        summary: "Slip and index trend with a suggested RAG",
        description: "scope: project:read. Read-only and derived from the daily project snapshots; nothing is written or audited. n (1 to 120, default 28) is how many of the latest snapshots to use. Returns declared_rag, suggested_rag (green | amber | red, or null with no snapshots or when the project is complete), reason, confidence (low under 3 snapshots, otherwise ok), trend, thresholds and the series (oldest first). The suggestion never changes the declared RAG.",
        operationId: "getProjectTrend",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "n", in: "query", schema: { type: "integer", default: 28, minimum: 1, maximum: 120 } },
        ],
        responses: {
          "200": { description: "Trend and suggested RAG", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Project not found in this workspace", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "n is not an integer from 1 to 120", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/reports/deck": {
      get: {
        tags: ["reports"],
        summary: "Generate portfolio deck report",
        description: "scope: audit:read and budget:read (BOTH are required — the deck carries budget figures: planned / committed / actual). ?format=html|pptx|pdf (default html). Optional ?sections=cover,rag,evm.",
        operationId: "getDeckReport",
        parameters: [
          { name: "format", in: "query", schema: { type: "string", enum: ["html", "pptx", "pdf"], default: "html" } },
          { name: "sections", in: "query", schema: { type: "string" }, description: "Comma-separated section keys" },
        ],
        responses: {
          "200": { description: "Report file (binary or HTML)" },
          "403": { description: "Missing audit:read or budget:read (code forbidden_scope) — both are required", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Invalid format", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["reports"],
        summary: "Generate portfolio deck report (POST variant)",
        description: "scope: audit:read and budget:read (BOTH are required). Same as GET but accepts a JSON body { format?, sections? } for structured agent use.",
        operationId: "postDeckReport",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { format: { type: "string", enum: ["html", "pptx", "pdf"] }, sections: { type: "array", items: { type: "string" } } } } } } },
        responses: {
          "200": { description: "Report file (binary or HTML)" },
          "403": { description: "Missing audit:read or budget:read (code forbidden_scope) — both are required", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Invalid format", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/reports/project/{id}": {
      get: {
        tags: ["reports"],
        summary: "Generate per-project status report",
        description: "scope: audit:read and budget:read (BOTH are required — the report carries budget figures: planned / committed / actual). ?format=html|pptx|pdf (default html). Optional ?sections=cover,rag,evm,risks,issues,milestones.",
        operationId: "getProjectReport",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "format", in: "query", schema: { type: "string", enum: ["html", "pptx", "pdf"], default: "html" } },
          { name: "sections", in: "query", schema: { type: "string" }, description: "Comma-separated section keys" },
        ],
        responses: {
          "200": { description: "Report file (binary or HTML)" },
          "403": { description: "Missing audit:read or budget:read (code forbidden_scope) — both are required", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Project not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Invalid format", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["reports"],
        summary: "Generate per-project status report (POST variant)",
        description: "scope: audit:read and budget:read (BOTH are required). Same as GET but accepts a JSON body { format?, sections? } for structured agent use.",
        operationId: "postProjectReport",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { format: { type: "string", enum: ["html", "pptx", "pdf"] }, sections: { type: "array", items: { type: "string" } } } } } } },
        responses: {
          "200": { description: "Report file (binary or HTML)" },
          "403": { description: "Missing audit:read or budget:read (code forbidden_scope) — both are required", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Project not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Invalid format", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/reports/handover": {
      get: {
        tags: ["reports"],
        summary: "Handover and key-person report",
        description: "scope: report:read (not privileged; report:* covers it). Read-only and derived; workspace-filtered. Per project: the open items whose single owner has no backup, grouped by owner with counts, plus the open items with no owner at all. Workspace key-person matrix: per person, items solely owned, projects touched, items backed up for others and bus_factor_1 (true when the person solely owns at least one open item). Open means: project not complete, risk not closed, issue not resolved or closed, task not completed or canceled. A resource member linked to a login is reported as that login. format=csv returns the same data as one CSV with a section column (item, unowned or person) and writes one export.csv audit row (entity handover); the JSON read writes no audit row.",
        operationId: "getHandoverReport",
        parameters: [
          { name: "project_id", in: "query", schema: { type: "string", format: "uuid" }, description: "Limit the report to one project in the caller's workspace (404 when it is not there, 422 when malformed)" },
          { name: "format", in: "query", schema: { type: "string", enum: ["json", "csv"], default: "json" }, description: "Any other value is 422" },
        ],
        responses: {
          "200": { description: "{ data: { generated_for, summary, projects, key_people } } as JSON, or text/csv when format=csv", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } }, "text/csv": { schema: { type: "string" } } } },
          "403": { description: "Missing report:read (forbidden_scope)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "project_id is not in this workspace", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Malformed project_id or format", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/reports/weekly": {
      get: {
        tags: ["reports"],
        summary: "Stored weekly status report (HTML)",
        description: "scope: report:read. Renders the report as it was generated (a stored snapshot, not live figures) as text/html with cache-control private, no-store. week = a calendar day (2026-10-22) or an ISO week (2026-W43), resolved to that week's Monday; omitted = the current week in the workspace time zone. Contents: workspace name, week, counts (projects, open high risks, pending approvals, stale items), a project table with project codes, milestones due in 14 days, the stalest items, and a section \"Emergency changes this week: N\" listing up to ten references and titles of emergency change requests raised in the last 7 days. The stored digest field is emergencyChanges: { count, items: [{ reference, title }] } (it replaces retroOverdue); reports stored before this change have neither field and render \"Emergency changes this week: 0\". The Lark weekly card carries the same line. Workspace-filtered.",
        operationId: "getWeeklyReport",
        parameters: [{ name: "week", in: "query", schema: { type: "string" }, description: "A calendar day or an ISO week" }],
        responses: {
          "200": { description: "The stored weekly report as HTML", content: { "text/html": { schema: { type: "string" } } } },
          "403": { description: "Missing report:read (forbidden_scope)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "No report was generated for that week", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "week is unreadable", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["reports"],
        summary: "Send the weekly report now",
        description: "scope: admin or manager SESSION only (403 for members, viewers and every token). No body. Refreshes the current week's stored report, creates a report.weekly notification for every admin and manager, and writes one report.weekly.generated audit row. It does not use the scheduled run's once-a-day slot, and it works while the scheduled report is disabled. Returns { week_start, recipients, report_url }.",
        operationId: "sendWeeklyReportNow",
        responses: {
          "200": { description: "{ week_start, recipients, report_url }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin or manager session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "The workspace has no admin or manager to notify", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/me": {
      get: {
        tags: ["auth"],
        summary: "Resolve the current actor",
        description: "scope: any valid auth (user session or token)",
        operationId: "getMe",
        responses: {
          "200": { description: "Actor identity", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["auth"],
        summary: "Update the current user's display name",
        description: "scope: user session only. Validates non-empty display_name, updates profile, writes audit row.",
        operationId: "patchMe",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["display_name"], properties: { display_name: { type: "string", minLength: 1 } } } } } },
        responses: {
          "200": { description: "Updated actor identity", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Token actors not allowed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/me/preferences": {
      get: {
        tags: ["auth"],
        summary: "Get the current user's DB-persisted display preferences (L-39)",
        description:
          "scope: user session only (token actors 403). Per-user, workspace-scoped display config " +
          "(columns per register, groupBy per register, density, dateDisplay, defaultLanding) — NOT " +
          "governance data, never audited (ADR 0009). `demo` in the response is true for the shared " +
          "demo login; the client should treat prefs as cookie/localStorage-only in that case, since a " +
          "DB write here would be shared across every visitor using that one identity.",
        operationId: "getMyPreferences",
        responses: {
          "200": { description: "Preferences config (empty object if none saved yet)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Token actors not allowed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      put: {
        tags: ["auth"],
        summary: "Merge-upsert the current user's DB-persisted display preferences (L-39)",
        description:
          "scope: user session only (token actors 403). Body { config: {...} } validated against a " +
          "closed key whitelist (unknown keys stripped, not rejected) then MERGED onto the existing " +
          "stored config: top-level keys present in the body override the same key on the existing " +
          "row, top-level keys absent from the body are preserved; `columns` and `groupBy` merge one " +
          "level deeper (per-register keys from the body override, other registers are preserved). " +
          "There is no way to delete a previously-saved key via this endpoint. The 10KB serialized-" +
          "size cap is checked against the MERGED result, not the raw body. No audit row is written " +
          "— per-user display state, not governance data (ADR 0009). Concurrent partial PUTs are " +
          "last-writer-wins on the merged object.",
        operationId: "putMyPreferences",
        requestBody: zodBody(putPreferencesBodySchema),
        responses: {
          "200": { description: "Preferences upserted", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Token actors not allowed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error (unrecognised value for a whitelisted key) or config exceeds the 10KB size cap", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/review": {
      get: {
        tags: ["review"],
        summary: "What is waiting for a human to decide? (read-only approvals queue)",
        description:
          "scope: task:read or audit:read or change:read or project:read. Any ONE of these opens the " +
          "endpoint, but each kind is shown only if the caller could read it through that family's own list endpoint " +
          "(task_deletion / project_deletion: task:read or audit:read; change_request: change:read; " +
          "rebaseline: project:read). Kinds the caller cannot read are named in `hidden_kinds`, so an EMPTY list is not " +
          "proof that nothing is pending; a caller who can read none of them gets 403. A signed-in user sees every kind. " +
          "Lists every governed decision currently waiting in the workspace, oldest first: deletion requests " +
          "(task + project), change requests (raised / under_review), rebaselines awaiting " +
          "sign-off. READ-ONLY — there is no way to decide anything here: each item says whether the caller `can_decide` it " +
          "(the decide scope AND four-eyes by person) and, when not, `reason_if_not`; the decision itself is made by a " +
          "person in the console, on a Lark card, or with the existing decision routes. Items the caller raised are still " +
          "listed, flagged as ones it cannot decide. `can_decide` is advisory — the decision routes re-check everything. " +
          "`total` is the exact count across the kinds the caller can read; paging reaches at most the oldest 1000 items " +
          "per kind. " +
          "Each item also carries assigned_approver_id (uuid or null) and assigned_to_me (boolean). Assignment is routing only and never changes can_decide. " +
          "Wave 4: the kinds gain risk_deletion, issue_deletion, expense_deletion, document_deletion and milestone_deletion. Each item carries " +
          "removes (what approving also detaches, such as a milestone's tasks; an empty list otherwise), tier and approval_deadline_at (both null when unknown), " +
          "and for a change request tier (emergency when it carries the flag). The review items no longer carry retro_due_at or retro_overdue: both fields were removed, so do not read them. An emergency change commits when raised and never appears as waiting. " +
          "Also available as the MCP / assistant tool list_pending_approvals and as `nopm review` in the CLI.",
        operationId: "listPendingApprovals",
        parameters: [
          { name: "mine", in: "query", schema: { type: "boolean" }, description: "1 or true: only requests assigned to the person behind the caller (a token counts as its creator). A caller with no resolvable person gets an empty list. total and paging reflect the filter." },
          {
            name: "kind",
            in: "query",
            style: "form",
            explode: false,
            schema: { type: "array", items: { type: "string", enum: [...PENDING_KINDS] } },
            description:
              "Restrict to these kinds — comma-separated (kind=rebaseline,change_request) or repeated. Default: every kind the " +
              "caller can read. An unknown kind is a 422; naming only kinds the caller cannot read is a 403.",
          },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: REVIEW_DEFAULT_LIMIT, minimum: 1, maximum: REVIEW_MAX_LIMIT } },
        ],
        responses: {
          "200": {
            description: "Pending approvals, oldest first",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "total", "page", "limit", "hidden_kinds"],
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/PendingApproval" } },
                    total: { type: "integer", description: "Exact number of pending items across the kinds the caller can read" },
                    page: { type: "integer", description: "Current page (1-based)" },
                    limit: { type: "integer", description: "Page size" },
                    hidden_kinds: { type: "array", items: { type: "string", enum: [...PENDING_KINDS] }, description: "Kinds omitted because the caller lacks their read scope" },
                  },
                },
              },
            },
          },
          "403": { description: "The token holds none of the read scopes, or asked (?kind) only for kinds it cannot read — an empty page would read as \"nothing waiting\"", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Unknown ?kind value (fields names the allowed kinds)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/calendar-feeds": {
      get: {
        tags: ["calendar"],
        summary: "List my calendar feeds (admin: every member's)",
        description:
          "scope: milestone:read. By default the caller's OWN active (non-revoked) milestone calendar feeds, newest first. " +
          "?scope=workspace (a signed-in workspace admin only; 403 otherwise) lists EVERY member's active feeds, each row " +
          "with `owner_name` (the owner's display name, null if the profile no longer resolves) so an admin can find and " +
          "revoke a departed employee's feed. The subscription URL or token is never returned here — the URL is shown " +
          "once, by POST. A token with no recorded owner owns no feeds and lists none in the default view.",
        operationId: "listCalendarFeeds",
        parameters: [
          { name: "scope", in: "query", schema: { type: "string", enum: ["mine", "workspace"], default: "mine" }, description: "workspace = every member's feeds (workspace admin only)" },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": { description: "Paginated calendar feed list (CalendarFeed[])", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
          "403": { description: "Missing milestone:read, or ?scope=workspace by a non-admin", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Unknown ?scope value", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["calendar"],
        summary: "Create a milestone calendar feed",
        description:
          "scope: milestone:write AND milestone:read AND project:read (viewers are refused) — the feed publishes " +
          "milestones plus project names and descriptions, so the creator must be able to read them. Mints a read-only iCalendar feed of milestone target dates " +
          "(all-day events) that Apple / Outlook / Google / Lark calendars can subscribe to. The subscription URL — " +
          "`url`, ending /api/calendar/npc_<secret>.ics — is returned ONCE; only the secret's SHA-256 is stored, and " +
          "the URL is the credential, so treat it as a secret. project_id omitted or null covers the whole workspace; a " +
          "value narrows the feed to that project (it must be in the caller's workspace). The feed belongs to a PERSON: a " +
          "token owns it as the user who minted it, and a token with no recorded owner cannot create one. Audited as " +
          "calendar_feed.create.",
        operationId: "createCalendarFeed",
        requestBody: zodBody(createCalendarFeedSchema),
        responses: {
          "201": {
            description: "Feed created — the feed row plus the one-time subscription `url`",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data"],
                  properties: {
                    data: {
                      allOf: [
                        { $ref: "#/components/schemas/CalendarFeed" },
                        { type: "object", required: ["url"], properties: { url: { type: "string", format: "uri", description: "Subscription URL — returned once, never again" } } },
                      ],
                    },
                  },
                },
              },
            },
          },
          "403": { description: "Missing milestone:write, milestone:read or project:read, a viewer, or a token with no recorded owner", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error, including a project_id that is not in this workspace", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/calendar-feeds/{id}": {
      delete: {
        tags: ["calendar"],
        summary: "Revoke a calendar feed",
        description:
          "scope: milestone:write. Only the feed's owner or a workspace admin may revoke it. Soft: the row stays for the " +
          "audit trail and the public feed URL stops working at once (404). Revoking twice is a 422, not a second audit " +
          "row. Audited as calendar_feed.revoke.",
        operationId: "revokeCalendarFeed",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Feed revoked (the CalendarFeed row, revoked_at set)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not the feed's owner or a workspace admin, or missing milestone:write", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Already revoked (code already_revoked)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/calendar/{token}": {
      get: {
        tags: ["calendar"],
        summary: "Subscribe to a milestone calendar (iCalendar)",
        description:
          "Public — no NoPM auth: the secret in the URL IS the credential, because a calendar app cannot send a Bearer " +
          "header. Returns an RFC 5545 calendar (text/calendar): one all-day VEVENT per milestone with a target date " +
          "(stable UID milestone-<id>@<host>, SEQUENCE from the later of the milestone's and its project's updated_at — " +
          "so renaming a project refreshes its events — and a deep link in URL), limited to the feed's workspace and, " +
          "if set, project. WINDOW: milestones from 90 days ago to the end of the schedule, in date order — older, " +
          "long-finished milestones fall out of the subscription (a subscribing client replaces its copy on every poll). " +
          "CAP: at most 2000 events; a feed that hits it answers with the header X-NoPM-Feed-Truncated: 1 (the far end " +
          "of the schedule is what is cut, never the near-term milestones). " +
          "REVALIDATION: the body carries a strong ETag (a hash of the deterministic serialisation); send it back as " +
          "If-None-Match and an unchanged feed answers 304 with no body. Cache-Control: private, max-age=900 and " +
          "Referrer-Policy: no-referrer on both 200 and 304. " +
          "THROTTLING (this route is public, so it limits itself): 120 requests/min per client address (only where the " +
          "deployment can determine one that a caller cannot write: on Vercel, or behind NOPM_TRUSTED_PROXY_HOPS reverse " +
          "proxies; otherwise only the per-feed cap applies), counted before " +
          "the token is looked up (NOPM_RATE_CAL_IP_PER_MIN), then 60/min per feed (NOPM_RATE_CAL_PER_MIN); over either " +
          "is 429 with Retry-After. Calendar apps poll every 15 minutes to a few hours, far below that. " +
          "Unknown, malformed and revoked tokens all get the same 404, so the response cannot be used to probe which " +
          "tokens exist. Not audited per fetch (a calendar polls every few minutes); the feed's last_fetched_at is " +
          "updated after the response, also for a 304. Create the URL with POST /calendar-feeds.",
        security: [],
        operationId: "getCalendarFeedIcs",
        parameters: [
          {
            name: "token",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^npc_[A-Za-z0-9_-]{43}(\\.ics)?$" },
            description: "The feed secret (npc_ + 43 URL-safe characters), optionally followed by .ics — the form calendar apps expect",
          },
          {
            name: "If-None-Match",
            in: "header",
            required: false,
            schema: { type: "string" },
            description: "An ETag from an earlier 200 (a list, or *): an unchanged feed answers 304 with no body",
          },
        ],
        responses: {
          "200": {
            description: "iCalendar document (CRLF line endings, 75-octet folding)",
            headers: {
              ETag: { schema: { type: "string" }, description: "Strong validator of this body" },
              "Cache-Control": { schema: { type: "string" }, description: "private, max-age=900" },
              "Referrer-Policy": { schema: { type: "string" }, description: "no-referrer" },
              "X-NoPM-Feed-Truncated": { schema: { type: "string", enum: ["1"] }, description: "Present only when the feed hit its 2000-event cap and the far end of the schedule was left out" },
            },
            content: { "text/calendar": { schema: { type: "string" } } },
          },
          "304": {
            description: "Not modified — the If-None-Match ETag still matches. No body; the ETag, Cache-Control and Referrer-Policy headers are repeated.",
            headers: {
              ETag: { schema: { type: "string" } },
              "Cache-Control": { schema: { type: "string" }, description: "private, max-age=900" },
              "Referrer-Policy": { schema: { type: "string" }, description: "no-referrer" },
            },
          },
          "404": { description: "Unknown, malformed or revoked feed token (one uniform response)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": {
            description: "Throttled (per client address or per feed). Body is { error: \"Too many requests\" } — note: no `code` field on this route.",
            headers: { "Retry-After": { schema: { type: "integer" }, description: "Seconds to wait" } },
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
    "/integrations/connectors": {
      get: {
        tags: ["integrations"],
        summary: "List the workspace's chat connectors (Lark / Feishu)",
        description:
          "scope: signed-in user session, any role (token actors get 403). The shape depends on the role. ADMIN: the full " +
          "masked view of every connector including revoked history — presence flags for the credentials (has_app_secret, " +
          "has_verification_token, has_encrypt_key, has_relay_secret, tenant_pinned), the non-secret config, the " +
          "callback_urls to paste into the platform console, and a `health` block (queue counts pending / retry / dead, " +
          "last_sent_at, last_error, last_cron_at, last_cron — null for a revoked connector or when the lookup failed); " +
          "never a secret value, ciphertext or hash. Any OTHER member, " +
          "viewers included: a REDACTED view of the live (non-revoked) connectors only — id, name, kind, status, region, " +
          "mode, approvals.enabled, digest.enabled — enough to say \"Lark is connected; approvals on\" without exposing " +
          "the app id, chat id or URLs. Unpaginated: page is always 1 and limit is the item count.",
        operationId: "listIntegrationConnectors",
        responses: {
          "200": {
            description: "Connector list — IntegrationConnector[] for an admin, IntegrationConnectorRedacted[] for any other member",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "total", "page", "limit"],
                  properties: {
                    data: { type: "array", items: { oneOf: [{ $ref: "#/components/schemas/IntegrationConnector" }, { $ref: "#/components/schemas/IntegrationConnectorRedacted" }] } },
                    total: { type: "integer" },
                    page: { type: "integer" },
                    limit: { type: "integer" },
                  },
                },
              },
            },
          },
          "403": { description: "Token actor — integrations are available to signed-in users only", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["integrations"],
        summary: "Connect a Lark / Feishu app",
        description:
          "scope: admin user session only (a manager, member, viewer or token gets 403). One live connector per workspace — " +
          "a second returns 422 (code connector_exists) until the first is revoked. app_secret, verification_token and " +
          "encrypt_key are encrypted at rest and NEVER returned by any API. encrypt_key is REQUIRED when mode is webhook " +
          "(the default): webhook mode makes the Lark-facing URLs public, and without the key the verification token — " +
          "which sits in clear text in every event and is visible to every collaborator on the Lark app — would be the " +
          "only proof an event came from Lark; with it every event is signed and encrypted. Omitting it is a 422 with " +
          "fields[encrypt_key]. long_connection mode never exposes a public URL, so it may omit the key. The relay " +
          "secret used by the self-host worker (mode long_connection) is generated here and returned exactly once as " +
          "`relay_secret` — store it now; only its hash is kept. digest.chat_id is required when digest.enabled. " +
          "Audited as integration.connector.create (the audit row carries the masked view — app id and chat id " +
          "abbreviated, because the audit stream is readable by every member — never a secret).",
        operationId: "createIntegrationConnector",
        requestBody: zodBody(createConnectorSchema),
        responses: {
          "201": {
            description: "Connector created — the masked view plus the one-time `relay_secret` and the `callback_urls`",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data"],
                  properties: {
                    data: {
                      allOf: [
                        { $ref: "#/components/schemas/IntegrationConnector" },
                        { type: "object", required: ["relay_secret"], properties: { relay_secret: { type: "string", description: "npr_... — shown once; only the self-host worker needs it" } } },
                      ],
                    },
                  },
                },
              },
            },
          },
          "403": { description: "Not an admin user session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error — including a webhook-mode connector without encrypt_key (fields[encrypt_key]) — or a live connector already exists in this workspace (code connector_exists)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "503": { description: "The server's credential-encryption key is not configured (code encryption_unavailable)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/integrations/connectors/{id}": {
      patch: {
        tags: ["integrations"],
        summary: "Update, pause or resume a connector",
        description:
          "scope: admin user session only. Rename, set status active <-> paused (the kill switch: paused stops BOTH " +
          "directions — no cards sent, no clicks accepted), change the non-secret config (merged over what is stored), " +
          "replace credentials (write-only: send only the ones that change), clear_tenant_pin to let the connector be re-" +
          "pinned by the next first account link made by an admin or manager, or rotate_relay_secret to mint a new relay " +
          "secret (returned once as `relay_secret`; the old one stops working). Revoking is DELETE, not a status here. " +
          "At least one field is required. WEBHOOK MODE NEEDS AN ENCRYPT KEY: whenever an update touches the mode or the " +
          "credentials and the connector will be in webhook mode, it must end up holding an encrypt_key — switching a " +
          "keyless long_connection connector to webhook without sending one, replacing credentials on a keyless webhook " +
          "connector without supplying one, or sending encrypt_key: null on a webhook connector is a 422 with " +
          "fields[encrypt_key]. A pause, a rename or a digest change is never held up by this. The app id cannot be " +
          "changed on an existing connector (422 code app_id_immutable): revoke it and create a new one for a different " +
          "app. Audited as " +
          "integration.connector.update — the row records WHICH secrets changed, never their values, and the app id " +
          "and chat id appear abbreviated (the audit stream is readable by every member).",
        operationId: "updateIntegrationConnector",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(updateConnectorSchema),
        responses: {
          "200": { description: "Updated connector (the masked view, without callback_urls); includes `relay_secret` once when rotate_relay_secret was set", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin user session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error — including a webhook-mode connector left without an encrypt_key (fields[encrypt_key]); the connector is revoked (code connector_revoked); or the stored credentials cannot be read and only part of them was sent (code secrets_unreadable)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "503": { description: "The server's credential-encryption key is not configured (code encryption_unavailable)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["integrations"],
        summary: "Revoke a connector",
        description:
          "scope: admin user session only. IRREVERSIBLE: the connector stops in both directions, every linked platform " +
          "account is unlinked, queued deliveries are superseded and unused link codes are deleted. Rows are kept (status " +
          "revoked) so the history stays auditable; a new connector can then be created. Audited as " +
          "integration.connector.revoke (counts of identities revoked and deliveries superseded).",
        operationId: "revokeIntegrationConnector",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Connector revoked (the masked view, status revoked)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin user session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Already revoked (code connector_revoked)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/integrations/connectors/{id}/test": {
      post: {
        tags: ["integrations"],
        summary: "Check a connector's credentials",
        description:
          "scope: admin user session only. A cheap credential probe: asks the platform for the bot's own info with the " +
          "stored app credentials. Read-style — it changes nothing in NoPM and by design writes no audit row. The result " +
          "is always HTTP 200 with data.ok true or false; a platform error text is sanitised (no secrets) and truncated.",
        operationId: "testIntegrationConnector",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": {
            description: "Probe result",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data"],
                  properties: {
                    data: {
                      type: "object",
                      required: ["ok"],
                      properties: {
                        ok: { type: "boolean" },
                        bot_name: { type: "string", description: "The bot's display name (when ok)" },
                        error: { type: "string", description: "Sanitised reason (when not ok), e.g. stored credentials cannot be decrypted" },
                      },
                    },
                  },
                },
              },
            },
          },
          "403": { description: "Not an admin user session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "The connector is revoked (code connector_revoked)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "503": { description: "The platform adapter is not available (code adapter_unavailable)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/integrations/connectors/{id}/digest": {
      post: {
        tags: ["integrations"],
        summary: "Send the workspace digest now",
        description:
          "scope: admin user session only. Gathers the workspace digest and posts it once, immediately, to the connector's " +
          "configured group chat. Because it sends workspace data to a third party it is audited BEFORE anything is queued " +
          "(integration.digest.send, trigger manual; the chat id appears abbreviated in the audit row). A manual send " +
          "never occupies the once-per-ISO-week scheduled slot. The delivery id is the platform idempotency key, so a " +
          "retry of a send whose first attempt actually landed cannot post twice. The connector must be active and " +
          "have a digest chat id.",
        operationId: "sendIntegrationDigest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": {
            description: "Digest queued and a delivery attempt made",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data"],
                  properties: {
                    data: {
                      type: "object",
                      required: ["delivery_id", "status"],
                      properties: {
                        delivery_id: { type: "string", format: "uuid" },
                        status: { type: "string", enum: ["sent", "retry", "dead", "queued"], description: "Outcome of the immediate attempt; retry = will be retried by the scheduler" },
                      },
                    },
                  },
                },
              },
            },
          },
          "403": { description: "Not an admin user session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "The connector is not active (code connector_not_active) or has no digest chat id (code digest_chat_missing)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/integrations/identities": {
      get: {
        tags: ["integrations"],
        summary: "List linked platform accounts",
        description:
          "scope: signed-in user session, any role (token actors get 403). Active links only. A member sees their own; a " +
          "workspace admin sees everyone's, or just their own with ?mine=1. Platform user ids are returned masked. " +
          "Unpaginated: page is always 1 and limit is the item count.",
        operationId: "listLinkedIdentities",
        parameters: [{ name: "mine", in: "query", schema: { type: "string", enum: ["1"] }, description: "Admin only: pass 1 to list just your own links" }],
        responses: {
          "200": {
            description: "Linked accounts",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "total", "page", "limit"],
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/LinkedIdentity" } },
                    total: { type: "integer" },
                    page: { type: "integer" },
                    limit: { type: "integer" },
                  },
                },
              },
            },
          },
          "403": { description: "Token actor — a token has no profile to link", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/integrations/identities/link-code": {
      post: {
        tags: ["integrations"],
        summary: "Mint a one-time code to link your platform account",
        description:
          "scope: signed-in user session, any role (token actors get 403). Mints a code of the form NPL-XXXX-XXXX, valid " +
          "10 minutes, single use, stored only as a hash; minting again replaces your previous unused code. You then send " +
          "`link <code>` to the bot in a direct message — the bot event carries the platform-verified user id, which is " +
          "what binds that account to YOUR NoPM profile (never by email match). Any member may link themselves, viewers " +
          "included: the link grants nothing by itself, and approving still needs the decide scope and an eligible role " +
          "at click time. Audited as integration.identity.code (the audit row never contains the code); the link itself " +
          "is audited as integration.identity.link with channel lark. Guarding the code: a failed or repeated `link` " +
          "attempt from the bot is rate-limited (8 per Lark account and 120 per connector per 10 minutes). If using a " +
          "code would REPLACE an earlier link of yours, the bot refuses (\"This NoPM account is already linked to another " +
          "Lark account. Unlink it in NoPM (Integrations) first, then send a new code.\"): the code is spent, the refusal " +
          "is audited as integration.identity.link.blocked, and your link is untouched, so a leaked or phished code cannot " +
          "re-point your approvals. (If two codes race and a link is still replaced, you get an in-app notice, type " +
          "integration.link_replaced, and the Lark account that lost it is told by direct message.) The first link made by an admin or manager also pins the connector to that Lark " +
          "tenant; a link by any other role never pins it.",
        operationId: "createIdentityLinkCode",
        responses: {
          "201": {
            description: "Code minted — returned once",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data"],
                  properties: {
                    data: {
                      type: "object",
                      required: ["code", "expires_at", "connector_id", "instructions"],
                      properties: {
                        code: { type: "string", pattern: "^NPL-[A-Z2-9]{4}-[A-Z2-9]{4}$" },
                        expires_at: { type: "string", format: "date-time" },
                        connector_id: { type: "string", format: "uuid" },
                        instructions: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
          "403": { description: "Token actor — linking needs a signed-in session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "No active connector in this workspace (code no_connector)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/integrations/identities/{id}": {
      delete: {
        tags: ["integrations"],
        summary: "Unlink a platform account",
        description:
          "scope: signed-in user session. The owner may unlink their own account; a workspace admin may unlink anyone's (a " +
          "leaver, say). Soft: the row keeps its history with revoked_at set, and any card the person still holds stops " +
          "working immediately (no active link = the click resolves to \"unlinked\"). Audited as integration.identity.unlink.",
        operationId: "unlinkIdentity",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Unlinked — { data: { id, revoked: true } }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Token actor, or an attempt to unlink someone else's account without being an admin", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Linked account not found (or already unlinked)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/cron/snapshots": {
      get: {
        tags: ["integrations"],
        summary: "Nightly project snapshot tick (host cron only)",
        description: "NOT a user or PAT route. The only credential is Authorization: Bearer <CRON_SECRET>, the same check as GET /integrations/cron. 401 otherwise, including when CRON_SECRET is unset. Takes one project_snapshots row per project per workspace for the workspace's current day. Idempotent: a second call the same day inserts nothing. Writes one snapshot.taken audit row per workspace per run, with taken_at, projects, taken and already_taken. Vercel Cron runs it at 37 17 * * * (17:37 UTC, 01:37 in the default Asia/Kuala_Lumpur zone), with maxDuration 60 seconds.",
        security: [{ cronSecret: [] }],
        operationId: "runSnapshotsCron",
        responses: {
          "200": { description: "{ data: { workspaces, projects, taken, skipped } }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "401": { description: "Missing or wrong CRON_SECRET (also when it is unset)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/integrations/cron": {
      get: {
        tags: ["integrations"],
        summary: "Daily scheduler tick (host cron only)",
        description:
          "NOT a user or PAT route. The only credential is Authorization: Bearer <CRON_SECRET> — the deployment's CRON_SECRET " +
          "environment variable, which the host's cron scheduler attaches to its own calls — compared in constant time; an " +
          "unset CRON_SECRET authorises nobody (and is logged, because it otherwise looks like a cron that merely never " +
          "runs). For every ACTIVE connector (paused and revoked ones are skipped entirely) it drains deliveries that are " +
          "due for retry, posts the weekly digest on the connector's configured weekday (UTC), once per ISO week (a weekday a tick missed " +
          "is made up by a later tick in the same ISO week, unless the connector was edited after that day began), and " +
          "prunes old bookkeeping rows (sent / dead / superseded deliveries after 60 days, spent action tokens 14 days " +
          "after expiry, inbound idempotency rows after 90 days — audit_log is never touched). Idempotent: a second call " +
          "the same day re-drains (leases prevent double sends) and never repeats a digest. Runs daily at 01:07 UTC " +
          "per vercel.json (off the hour and half-hour, when the platform sheds load). It is only the FLOOR of the retry " +
          "ladder (1 m, 5 m, 30 m, 2 h, 12 h, then dead): due retries are also drained whenever the workspace has " +
          "approval traffic. It is built to finish inside the 60 s function limit: every connector's digest is queued " +
          "first (database work only, so being cut off cannot lose a week's digest), connectors are drained 3 at a time, " +
          "and no new work STARTS after 40 s — what is left stays queued for the next tick. " +
          "A nudge step runs for every workspace, with or without a connector: open items older than stale_days get one in-app notification each (at most once per item per day), and the weekly report is stored and notified on its configured weekday. The summary gains nudges { workspaces, staleNudged, weeklyReports, failed, skippedForDeadline }. " +
          "WAVE 4: an approval timer step runs for every workspace after the nudges. It reminds the approvers of a waiting request at half its turnaround, " +
          "escalates to the admins past the deadline, and approves a routine request nobody decided " +
          "only where the workspace admin switched auto-approve on (never with a cost or a schedule impact). The summary gains approvals { workspaces, examined, reminders, escalated, autoApproved, retroOverdue, failed, skippedForDeadline }; retroOverdue is always 0 now: the retro_overdue approval event is no longer written, and the approval.timer_run audit row carries retroOverdue 0.",
        security: [{ cronSecret: [] }],
        operationId: "runIntegrationsCron",
        responses: {
          "200": {
            description: "Tick summary",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data"],
                  properties: {
                    data: {
                      type: "object",
                      properties: {
                        connectors: { type: "integer", description: "Active connectors visited" },
                        deliveries: {
                          type: "object",
                          properties: {
                            claimed: { type: "integer" },
                            sent: { type: "integer" },
                            retried: { type: "integer" },
                            dead: { type: "integer" },
                            superseded: { type: "integer" },
                            deferred: { type: "integer" },
                            deadlineSkipped: { type: "integer", description: "Rows the deadline stopped us reaching; still queued" },
                          },
                        },
                        digests: {
                          type: "object",
                          description: "One count per connector",
                          properties: {
                            sent: { type: "integer", description: "Went out" },
                            skipped: { type: "integer", description: "None owed this tick, or already queued this ISO week" },
                            queued: { type: "integer", description: "Claimed and waiting — the deadline stopped us before its send; the next tick delivers it" },
                            failed: { type: "integer", description: "The step threw, or its send failed and is waiting to retry or is dead" },
                          },
                        },
                        skippedForDeadline: { type: "integer", description: "Connectors the deadline stopped us reaching (their queue is untouched for the next tick)" },
                        timedOut: { type: "integer", description: "Connector jobs that overran the deadline and were abandoned" },
                        pruned: {
                          type: "object",
                          properties: { deliveries: { type: "integer" }, action_tokens: { type: "integer" }, inbound_actions: { type: "integer" } },
                        },
                        elapsedMs: { type: "integer" },
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { description: "Missing or wrong CRON_SECRET (code unauthorized)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/integrations/lark/{connectorId}/events": {
      post: {
        tags: ["integrations"],
        summary: "Lark / Feishu event subscription endpoint (called by the platform)",
        description:
          "Public (no NoPM token): the caller is the platform, authenticated by the connector's Verification Token and, when " +
          "an Encrypt Key is configured, by the signed + encrypted body (see the larkWebhook security scheme and the " +
          "X-Lark-* headers). Hosted 'webhook' mode only. The body is the platform's contract, NOT NoPM's { data } " +
          "envelope. url_verification handshake -> { challenge }. im.message.receive_v1 (a direct message to the bot) -> " +
          "{} at once; the commands `help`, `link <code>` and `approvals` are answered afterwards as a DM from the bot, " +
          "and anything else gets the help card. card.action.trigger -> the card route's reply (so one URL pasted into both " +
          "console fields also works). Any other event -> {}. An unknown, paused or revoked connector and every " +
          "verification failure are ONE generic 401 { error: \"Invalid request\" } — same body, same work (the request " +
          "is run through the verifier either way), reason logged server-side only — so the endpoint is neither a " +
          "connector-state nor a decryption oracle. A malformed id is 404. Only an ACTIVE connector that cannot decrypt " +
          "its own stored secrets (an operator fault) answers differently: a generic 503 { error: \"Service unavailable\" }. " +
          "Webhook mode needs an Encrypt Key on the connector, so a correctly configured connector only ever accepts " +
          "signed + encrypted events. Authenticated requests are limited to 300/min per connector " +
          "(NOPM_RATE_LARK_PER_MIN); failed verifications are capped separately — 30/min per connector and 60/min per " +
          "client network (the network key is the address your own proxy appended, see NOPM_TRUSTED_PROXY_HOPS; failures " +
          "from an unknown connector can only be counted per network) — and answered 429 with Retry-After.",
        security: [{ larkWebhook: [] }],
        operationId: "larkEvents",
        parameters: [connectorIdParam, ...larkSignatureHeaders],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                description: "The platform's event envelope — either plaintext (schema 2.0 header/event, or the legacy url_verification body) or { \"encrypt\": \"<base64>\" } when an Encrypt Key is set. Max 256 KiB.",
                additionalProperties: true,
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The platform's expected reply: { challenge } for url_verification, {} for events, or { toast, card? } when the envelope is a card action",
            content: {
              "application/json": {
                schema: {
                  anyOf: [
                    { type: "object", required: ["challenge"], properties: { challenge: { type: "string" } } },
                    { type: "object", maxProperties: 0 },
                    { $ref: "#/components/schemas/LarkCardCallbackResponse" },
                  ],
                },
              },
            },
          },
          "401": { description: "Verification failed (bad signature, stale timestamp, undecryptable body or wrong verification token), or the connector is unknown, paused or revoked — one generic body { error: \"Invalid request\" }", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "403": { description: "The connector is not in webhook mode (code wrong_mode) — only returned to an authenticated caller", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Malformed connector id only — { error: \"Not found\" }. An unknown, paused or revoked connector is the generic 401 instead.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "413": { description: "Body larger than 256 KiB", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "Per-connector budget exceeded, or too many failed verifications (per connector or per client network) — Retry-After header gives the seconds", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "503": { description: "The active connector's stored credentials cannot be decrypted — { error: \"Service unavailable\" }", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/integrations/lark/{connectorId}/card": {
      post: {
        tags: ["integrations"],
        summary: "Lark / Feishu card callback endpoint (called by the platform)",
        description:
          "Public (no NoPM token), authenticated exactly like /events. The platform posts card.action.trigger here when a " +
          "person presses Approve or Reject on an approval card. The ONLY mutation reachable is a human, identity-" +
          "verified, single-use approve / reject of an existing governed request: the button's { t, a } is handed to " +
          "the integration hub, which maps the platform-verified operator to a linked NoPM user, consumes the single-use " +
          "recipient-bound token and runs the same decision as the console — scopes, four-eyes by person, locks and one " +
          "audit row with channel lark. APPROVE WHAT YOU SAW: a card is a snapshot with a seven-day life but the request " +
          "behind it can be edited (a change request's cost or scope, say). The card's token carries the request's content " +
          "version, and a tap on a card whose request has since changed decides NOTHING — it answers a `changed` toast and " +
          "fresh cards with the current content are issued to the approvers; the same version also pins the decision " +
          "write itself, so an edit landing between the check and the write fails the decision rather than slipping " +
          "through. No linked account, an expired or spent card, a non-recipient, a self-approval, an already-decided " +
          "request and a changed request are each answered with a toast, never an HTTP error. Replies HTTP 200 within the " +
          "platform's 3 s deadline with { toast, card? }: the toast is shown to the person, the card (if any) replaces the " +
          "one they pressed. Even a rate-limited click gets a 200 toast. The body is the platform's contract, not the " +
          "{ data } envelope.",
        security: [{ larkWebhook: [] }],
        operationId: "larkCardCallback",
        parameters: [connectorIdParam, ...larkSignatureHeaders],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                description: "The platform's card.action.trigger envelope (schema 2.0), plaintext or { \"encrypt\": \"<base64>\" }. Max 256 KiB.",
                additionalProperties: true,
              },
            },
          },
        },
        responses: {
          "200": { description: "Toast, and optionally a replacement card", content: { "application/json": { schema: { $ref: "#/components/schemas/LarkCardCallbackResponse" } } } },
          "401": { description: "Verification failed, or the connector is unknown, paused or revoked — one generic body { error: \"Invalid request\" }", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "403": { description: "The connector is not in webhook mode (code wrong_mode)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Malformed connector id only. An unknown, paused or revoked connector is the generic 401.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "413": { description: "Body larger than 256 KiB", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "Too many failed verifications (per connector or per client network) — Retry-After header gives the seconds", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "503": { description: "The active connector's stored credentials cannot be decrypted — { error: \"Service unavailable\" }", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/integrations/lark/{connectorId}/relay": {
      post: {
        tags: ["integrations"],
        summary: "Self-host relay endpoint (called by the long-connection worker)",
        description:
          "Public (no NoPM token), authenticated by an HMAC over the exact raw body (see the relayHmac security scheme). A " +
          "self-hosted NoPM has no public URL, so Lark cannot call the webhook routes; web/scripts/lark-worker.mjs holds an " +
          "OUTBOUND long connection to Lark and forwards each event here, signed with the connector's relay secret. " +
          "Requires the connector to be in mode long_connection. From here the request takes the SAME governed path as a " +
          "hosted webhook delivery (identity link, four-eyes, one audit row with channel lark); this route authenticates the " +
          "TRANSPORT only, decides nothing itself and writes no audit row, so a ping or a rejected request mutates nothing. " +
          "Body: { type: \"ping\" } | { type: \"event\" | \"card\", payload: <Lark v2 envelope> } — the envelope carries no " +
          "verification token (the HMAC replaces it), and `type` must agree with header.event_type (card <-> " +
          "card.action.trigger). Replies: ping -> { data: { ok, connector_id, mode, status } } (the only { data }-wrapped " +
          "success); event -> {} (a bot reply, if any, is sent after the response); card -> { toast, card? } returned to Lark " +
          "VERBATIM. Errors use the standard { error, code } contract. Replay safety comes from the layer below — inbound " +
          "actions are idempotent on the platform event id and action tokens are single-use — so a replayed request is a no-op. " +
          "Limits: 120/min per client network (before authentication) and 600/min per connector; a rate-limited CARD click " +
          "is answered 200 with a toast instead of an error. The pre-authentication network key is the address YOUR proxy " +
          "appended to X-Forwarded-For, never the caller's own first entry: on Vercel it is read from the platform's " +
          "header; anywhere else NOTHING is trusted unless NOPM_TRUSTED_PROXY_HOPS is set to the number of reverse proxies " +
          "you run in front of the app (1 for a single nginx / Caddy / load balancer). With no trustworthy address the " +
          "pre-authentication cap is skipped and the HMAC and the per-connector cap are the only guards (IPv6 clients " +
          "share a bucket per /64). Whether a connector exists is not revealed before the signature is checked: an " +
          "unknown id gets the same 401 invalid_relay_signature, after the same work, as a wrong signature.",
        security: [{ relayHmac: [] }],
        operationId: "larkRelay",
        parameters: [
          connectorIdParam,
          { name: "X-NoPM-Relay-Timestamp", in: "header", required: true, schema: { type: "string", pattern: "^\\d{1,12}$" }, description: "Unix seconds, decimal; must be within +/-300 s of the server clock" },
          { name: "X-NoPM-Relay-Signature", in: "header", required: true, schema: { type: "string", pattern: "^v1=[0-9a-f]{64}$" }, description: "v1=<hex HMAC-SHA256 of `<timestamp>.<raw body>`>, keyed with the 64-character lowercase-hex string of SHA-256(raw relay secret)" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  { type: "object", required: ["type"], properties: { type: { type: "string", enum: ["ping"] } }, description: "A signed no-op the worker sends at boot to prove URL, connector id, secret and mode" },
                  {
                    type: "object",
                    required: ["type", "payload"],
                    properties: {
                      type: { type: "string", enum: ["event", "card"] },
                      payload: {
                        type: "object",
                        required: ["header", "event"],
                        description: "The Lark v2 event envelope",
                        properties: {
                          schema: { type: "string" },
                          header: { type: "object", required: ["event_id", "event_type"], properties: { event_id: { type: "string", maxLength: 256 }, event_type: { type: "string", maxLength: 128 } }, additionalProperties: true },
                          event: { type: "object", additionalProperties: true },
                        },
                        additionalProperties: true,
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "ping -> { data: { ok, connector_id, mode, status } }; event -> {}; card -> { toast, card? }",
            content: {
              "application/json": {
                schema: {
                  anyOf: [
                    {
                      type: "object",
                      required: ["data"],
                      properties: {
                        data: {
                          type: "object",
                          properties: {
                            ok: { type: "boolean" },
                            connector_id: { type: "string", format: "uuid" },
                            mode: { type: "string", enum: ["webhook", "long_connection"] },
                            status: { type: "string", enum: ["active", "paused", "revoked"] },
                          },
                        },
                      },
                    },
                    { type: "object", maxProperties: 0 },
                    { $ref: "#/components/schemas/LarkCardCallbackResponse" },
                  ],
                },
              },
            },
          },
          "401": { description: "Bad signature or missing headers, or an UNKNOWN connector id (code invalid_relay_signature — indistinguishable from a wrong signature); timestamp outside +/-300 s (stale_relay_timestamp); or the connector has no relay secret (no_relay_secret)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "403": { description: "The connector is not active (connector_inactive) or not in long_connection mode (wrong_mode) — only revealed to an authenticated caller", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Malformed connector id only (code connector_not_found)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "413": { description: "Body larger than 256 KiB (code body_too_large)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Not valid JSON, wrong shape (fields lists the problems), or type does not match the event type (code invalid_relay_request)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "Rate limit exceeded (code rate_limited)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "503": { description: "The connector's stored credentials cannot be decrypted (code connector_unavailable) — a generic body; the operator sees the cause in the server log", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/integrations/github/connector": {
      get: {
        tags: ["integrations"],
        summary: "Read the GitHub connector and its event mapping (wave 4)",
        description:
          "Session only: a token gets 403. Any signed-in member may read it; the webhook secret is never returned here. data = { connector: null | GithubConnector (members see only { name, status }), can_manage, rules, rule_targets, work_events }. " +
          "rules maps each event to the task status it moves to: pr_opened, pr_merged, pr_closed, deploy_success, deploy_failure, each unstarted | started | in_review | canceled, or null to leave the task as it is. A work event never completes a task: completing a task is a human action, and completed is not an accepted rule value. rule_targets lists those four values. Defaults: pr_opened started, pr_merged in_review, pr_closed none, deploy_success none, deploy_failure none. A workspace that stored completed before this change reads back as null for that event until migration 0106 rewrites it.",
        operationId: "getGithubConnector",
        responses: {
          "200": { description: "Connector view and mapping", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "A token (session only)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["integrations"],
        summary: "Connect the GitHub repository webhook (admin session)",
        description:
          "Admin session only. Creates the workspace's one live GitHub connector. The webhook secret is shown ONCE in the response (webhook_secret) and stored encrypted (AES-256-GCM). " +
          "Paste webhook_url and the secret into the repository webhook: content type application/json, events Pull requests and Deployment statuses. Audited integration.connector.create.",
        operationId: "createGithubConnector",
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 100 } } } } } },
        responses: {
          "201": { description: "Connector created — the view plus webhook_secret (shown once)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin session (a member, a viewer or any token)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "connector_exists — a live connector already exists in this workspace", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "503": { description: "encryption_unavailable — the server cannot encrypt the webhook secret", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["integrations"],
        summary: "Pause or resume, change the event mapping, or rotate the secret (admin session)",
        description:
          "Admin session only. Body: any subset of status (active | paused; paused is the kill switch: every delivery answers 401), rules (an object of event to unstarted | started | in_review | canceled, or null to leave the task as it is; completed is not accepted, and unknown events or statuses are 422), and rotate_secret (true). At least one field. " +
          "Rotating returns a new webhook_secret once and the old one stops working at once. Audited integration.connector.update, and work_event_rules.update when rules change.",
        operationId: "updateGithubConnector",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                minProperties: 1,
                properties: {
                  status: { type: "string", enum: ["active", "paused"] },
                  rules: { type: "object", additionalProperties: { type: ["string", "null"], enum: ["unstarted", "started", "in_review", "canceled", null] } },
                  rotate_secret: { type: "boolean", enum: [true] },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "{ connector, rules, webhook_secret? } — webhook_secret only on rotate", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "No connector exists to change", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Unknown field, event or status, or no field sent. A rule of completed is refused: { error: \"Validation failed\", fields: [{ field: \"rules\", message: \"rules.<event>: A work event cannot complete a task. Completing a task is a human action; map the event to unstarted, started, in_review or canceled, or leave it unset.\" }] }", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["integrations"],
        summary: "Revoke the GitHub connector (admin session)",
        description: "Admin session only. Revokes the live connector: its webhook address stops answering with a change. Returns the revoked connector view. Audited integration.connector.revoke.",
        operationId: "revokeGithubConnector",
        responses: {
          "200": { description: "The revoked connector view", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "No connector exists", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/integrations/github/work-events": {
      get: {
        tags: ["integrations"],
        summary: "Recent GitHub work events and what happened to each (wave 4)",
        description:
          "Session only (a token gets 403); any signed-in member may read it. Newest first, workspace-filtered. Each row says whether it applied the task move and, when it did not, why (reason): project_locked, unknown_ref, no_rule, already_at_or_beyond, task_canceled, conflict, no_linked_pr, error, replay (the same delivery again, changes nothing), truncated (more than five pull requests in one delivery), or applied / received.",
        operationId: "listGithubWorkEvents",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 20 } }],
        responses: {
          "200": { description: "List of GithubWorkEvent rows", content: { "application/json": { schema: { type: "object", required: ["data"], properties: { data: { type: "array", items: { $ref: "#/components/schemas/GithubWorkEvent" } } } } } } },
          "403": { description: "A token (session only)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/integrations/github/{connectorId}/events": {
      post: {
        tags: ["integrations"],
        summary: "GitHub webhook endpoint (called by GitHub, not an agent)",
        description:
          "Public: no NoPM token. The caller is GitHub, authenticated by the HMAC-SHA256 signature of the raw body in X-Hub-Signature-256 under the connector's secret (compared in constant time). " +
          "Acts on exactly two events: pull_request (opened or reopened, closed, merged) and deployment_status (success, failure, error). A deployment names its pull request through its payload, or a refs/pull/N or pr-N ref; at most five pull requests per delivery (a delivery naming more is recorded with reason truncated)." +
          "A move applies only to the task whose external_ref equals github:<owner>/<repo>#<number> inside the connector's workspace, never on a locked project, and never moves a task backwards or out of completed or canceled, and never completes one. " +
          "Every move is one audited task update as a connector actor (channel github). A replay of the same X-GitHub-Delivery answers 200 and changes nothing. A ping and any other event answer 200 and change nothing. " +
          "One generic 401 covers a bad or missing signature and an unknown, paused or revoked connector. The body is capped at 1 MiB and the endpoint is rate-limited per connector.",
        security: [],
        operationId: "githubWebhook",
        parameters: [
          connectorIdParam,
          { name: "X-Hub-Signature-256", in: "header", required: true, schema: { type: "string" }, description: "sha256= followed by the hex HMAC-SHA256 of the raw body" },
          { name: "X-GitHub-Event", in: "header", required: true, schema: { type: "string" }, description: "pull_request, deployment_status or any other event name (ignored)" },
          { name: "X-GitHub-Delivery", in: "header", required: true, schema: { type: "string" }, description: "GitHub's unique delivery id; a recorded delivery is never applied twice" },
        ],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", description: "The GitHub pull_request or deployment_status payload, as GitHub sends it. Max 1 MiB.", additionalProperties: true } } } },
        responses: {
          "200": { description: "{ ok: true }. Also returned for a replay, for ping and for any event that changes nothing.", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
          "400": { description: "{ error: \"bad_request\" } — signed but no delivery id, or unreadable JSON", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "401": { description: "{ error: \"unauthorized\" } — bad or missing signature, or an unknown, paused or revoked connector", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Malformed connector id", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "413": { description: "Body larger than 1 MiB", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "Too many deliveries, or too many failed signatures, for this connector. Retry-After gives the seconds.", headers: { "Retry-After": { schema: { type: "integer" } } }, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "503": { description: "Nothing was recorded; GitHub may redeliver safely", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/mcp": {
      post: {
        tags: ["mcp"],
        summary: "Remote MCP server (Streamable HTTP) — JSON-RPC",
        description:
          "scope: the caller's own scoped PAT (Authorization: Bearer npm_...), read on EVERY request and forwarded " +
          "verbatim to this same origin's REST API — so scopes, audit and maker-checker are enforced there, unchanged; " +
          "this route holds no credentials of its own. Exposes the same " + TOOL_REGISTRY.length + " governed tools as the " +
          "stdio server (web/mcp/server.mjs); none can approve or decide. Stateless: a fresh server per request, so there is no session " +
          "to resume. Send Accept: application/json, text/event-stream and a JSON-RPC body. A tool-level failure surfaces " +
          "as a normal { error } tool result. A missing Authorization header is a 401 in the standard { error, code } " +
          "contract with code unauthorized, a WWW-Authenticate: Bearer realm=\"nopm\" challenge and an X-Request-Id " +
          "correlation header (the caller's own when it is a safe token).",
        security: [{ bearerAuth: [] }],
        operationId: "mcpPost",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", description: "A JSON-RPC 2.0 request (initialize, tools/list, tools/call, ...)", additionalProperties: true } } } },
        responses: {
          "200": { description: "JSON-RPC response (JSON mode)", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
          "401": { description: "No Bearer token was sent — { error, code: \"unauthorized\" } with a WWW-Authenticate: Bearer realm=\"nopm\" header", headers: { "WWW-Authenticate": { schema: { type: "string" }, description: "Bearer realm=\"nopm\"" } }, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "406": { description: "Accept header does not include both application/json and text/event-stream" },
        },
      },
      get: {
        tags: ["mcp"],
        summary: "Remote MCP server (Streamable HTTP) — event stream verb",
        description:
          "scope: the caller's own PAT (Bearer), required like POST. The Streamable HTTP transport's standalone event-stream " +
          "verb, handled by the MCP SDK. The server is stateless, so MCP clients drive it with POST; a request without a " +
          "Bearer token gets the same 401 { error, code: \"unauthorized\" } + WWW-Authenticate challenge.",
        security: [{ bearerAuth: [] }],
        operationId: "mcpGet",
        responses: {
          "401": { description: "No Bearer token — { error, code: \"unauthorized\" } + WWW-Authenticate: Bearer realm=\"nopm\"", headers: { "WWW-Authenticate": { schema: { type: "string" }, description: "Bearer realm=\"nopm\"" } }, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "406": { description: "Accept header does not include text/event-stream" },
        },
      },
      delete: {
        tags: ["mcp"],
        summary: "Remote MCP server (Streamable HTTP) — session termination verb",
        description:
          "scope: the caller's own PAT (Bearer), required like POST. The Streamable HTTP transport's session-termination " +
          "verb, handled by the MCP SDK; the server keeps no sessions, so there is nothing to terminate. A request without " +
          "a Bearer token gets the same 401 { error, code: \"unauthorized\" } + WWW-Authenticate challenge.",
        security: [{ bearerAuth: [] }],
        operationId: "mcpDelete",
        responses: {
          "401": { description: "No Bearer token — { error, code: \"unauthorized\" } + WWW-Authenticate: Bearer realm=\"nopm\"", headers: { "WWW-Authenticate": { schema: { type: "string" }, description: "Bearer realm=\"nopm\"" } }, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
  },
};

/**
 * Cross-tenant reference guard (assertRefsInWorkspace, @/lib/api/workspace-refs).
 *
 * Every route below checks that the listed body fields — ids that point at
 * another record — live in the caller's workspace, and answers 422 with code
 * `invalid_reference` and a `fields` list when one does not. The table is the
 * one place that names them, keyed "method /path", and it is applied to the
 * operations' 422 responses after the spec is built, so a new guarded route is
 * one line here instead of a hand-edited sentence. Keep it in step with the
 * `assertRefsInWorkspace(...)` calls (grep for them): a route in this table
 * that no longer checks a field, or a guarded route missing from it, is drift.
 */
const REFERENCE_CHECKED_FIELDS: Record<string, string> = {
  "post /allocations": "member_id, project_id, task_id",
  "patch /allocations/{id}": "member_id, project_id, task_id",
  "post /clashes": "project_a_id, project_b_id, resource_member_id, owner_id",
  "patch /clashes/{id}": "project_a_id, project_b_id, resource_member_id, owner_id",
  "post /projects/{id}/decisions": "supersedes",
  "patch /decisions/{id}": "supersedes",
  "post /documents": "project_id, owner_id",
  "patch /documents/{id}": "project_id, owner_id",
  "post /projects/{id}/issues": "owner_id",
  "patch /issues/{id}": "owner_id",
  "post /projects/{id}/milestones": "owner_id",
  "patch /milestones/{id}": "owner_id",
  "post /programs": "owner_id (a resource member)",
  "patch /programs/{id}": "owner_id (a resource member)",
  "post /projects": "owner_id",
  "patch /projects/{id}": "owner_id",
  "post /projects/{id}/risks": "owner_id",
  "patch /risks/{id}": "owner_id",
  "post /projects/{id}/tasks": "assignee_id (a resource member), blocked_by (a task)",
  "patch /tasks/{id}": "assignee_id (a resource member), blocked_by (a task)",
  "post /resources": "profile_id",
  "patch /resources/{id}": "profile_id",
};

type DecoratedOperation = {
  responses: Record<string, { description?: string; content?: unknown; $ref?: string }>;
};

function documentReferenceGuard(): void {
  const paths = spec.paths as unknown as Record<string, Record<string, DecoratedOperation | undefined>>;
  for (const [key, fields] of Object.entries(REFERENCE_CHECKED_FIELDS)) {
    const [method, path] = key.split(" ");
    const operation = paths[path]?.[method];
    if (!operation) throw new Error(`REFERENCE_CHECKED_FIELDS names ${key}, which is not in the spec`);
    const note =
      `invalid_reference — ${fields} must exist in this workspace (code invalid_reference; fields[] names each offending field; ` +
      "null clears a reference and is always allowed)";
    const existing = operation.responses["422"];
    if (existing?.description?.includes("invalid_reference")) continue;
    operation.responses["422"] = existing
      ? { ...existing, description: `${existing.description ?? "Validation error"}; or ${note}` }
      : { description: `Validation error, or ${note}`, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
  }
}

documentReferenceGuard();

export const GET = route(async () => Response.json(spec), { auth: false });

// Exported for the openapi-coverage drift test only.
// Do NOT import this in production application code.
export const specForTesting = spec;

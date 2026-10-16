import { route } from "@/lib/api/handler";
import { z } from "zod";
import { createProjectSchema, updateProjectSchema, ProjectDeleteRequestSchema } from "@/app/api/projects/_schema";
import { createProgramSchema, updateProgramSchema } from "@/app/api/programs/_schema";
import { createSprintSchema, updateSprintSchema, sprintTaskAttachSchema } from "@/app/api/sprints/_schema";
import { createTimesheetSubmissionSchema, timesheetDecisionSchema } from "@/app/api/timesheet-submissions/_schema";
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
      "Project deletion is maker-checker too (owner-locked, PROJECTS ONLY): DELETE /projects/{id} " +
      "creates a deletion_request the same way — milestones/risks/issues remain single-step hard " +
      "deletes and are never routed through deletion_requests. " +
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
      "(task:delete:approve, project:delete:approve, time:approve, change:decide, rebaseline:approve) " +
      "are NEVER granted by a wildcard (* or task:*, time:*, ...): each must be granted by its exact " +
      "name. Agents never approve: GET /review lists what is waiting for a human, and the decision is " +
      "made by a person in the console or on a chat card. " +
      "Error bodies carry a stable machine-readable `code` beside `error` (e.g. unauthorized, " +
      "forbidden_scope, not_found, rule_violation, rate_limited, self_approval, no_principal, " +
      "already_decided, project_locked) — branch on it, not on the message. " +
      "Integrations (Lark / Feishu): a workspace admin connects ONE app per workspace under " +
      "/integrations/connectors; approvers get a card with Approve / Reject buttons, and every click " +
      "runs the same governed decision as the console (one audit row, channel `lark`). The three " +
      "/integrations/lark/{connectorId}/* routes are called by the platform (or the self-host " +
      "relay worker), authenticate by signature rather than a NoPM token, and answer in the " +
      "PLATFORM's contract, not the { data } envelope. A read-only milestone calendar feed " +
      "(/calendar-feeds, /calendar/{token}) lets any calendar app subscribe.",
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
              "already_decided, project_locked). Branch on this, not on the message.",
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
          id: { type: "string", format: "uuid", description: "The request's id in its own family (deletion request, change request, timesheet submission or rebaseline)" },
          title: { type: "string" },
          summary: { type: ["string", "null"], description: "One line of context (reason / status / hours)" },
          project_id: { type: ["string", "null"], format: "uuid" },
          project_name: { type: ["string", "null"] },
          requested_by_label: { type: ["string", "null"] },
          requested_at: { type: "string", format: "date-time" },
          can_decide: { type: "boolean", description: "Whether THIS caller could decide it (decide scope + four-eyes by person). Advisory — the decision routes re-check everything." },
          reason_if_not: { type: ["string", "null"], description: "Why the caller cannot decide it; null when can_decide is true" },
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
          tenant_pinned: { type: "boolean", description: "true once the first account link pinned the connector to one Lark tenant" },
          created_by: { type: ["string", "null"], format: "uuid" },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
          revoked_at: { type: ["string", "null"], format: "date-time" },
          callback_urls: { $ref: "#/components/schemas/LarkCallbackUrls" },
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
    responses: {
      RateLimited: {
        description:
          "429 — baseline rate limit exceeded (workspace+actor-class, fixed 60s window; " +
          "defaults 600/min read, 120/min write; configurable via NOPM_RATE_READ_PER_MIN / " +
          "NOPM_RATE_WRITE_PER_MIN). Applies to every authenticated route in this API — " +
          "documented once here rather than per-path. code: rate_limited.",
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
        description: "scope: admin or manager user session",
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
        description: "scope: admin or manager user session. Raw token returned once only.",
        operationId: "createToken",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name", "scopes"], properties: { name: { type: "string" }, scopes: { type: "array", items: { type: "string" } }, expires_at: { type: "string", format: "date-time" } } } } } },
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
        description: "scope: admin or manager user session. Sets revoked=true.",
        operationId: "revokeToken",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Token revoked", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
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
          "now + 7 days. Raw invite link (invite_url) is returned ONCE and never stored/logged again.",
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
    "/invites/accept": {
      post: {
        tags: ["invites"],
        summary: "Accept a link invite — provisions a new login (L-47/L-48)",
        description:
          "No auth required — this is the one route in NoPM that creates a brand-new auth user from an " +
          "unauthenticated request. Rate-limited explicitly (10/req per minute, keyed by IP — this " +
          "endpoint cannot use the baseline actor-keyed limiter since there is no actor pre-auth). Body " +
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
        ],
        responses: {
          "200": { description: "Paginated project list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["projects"],
        summary: "Create a project",
        description: "scope: project:write",
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
        description: "scope: project:write",
        operationId: "updateProject",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(updateProjectSchema),
        responses: {
          "200": { description: "Updated project", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "412": { $ref: "#/components/responses/PreconditionFailed" },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
          "the request was raised. Owner-locked (Decision 3, " +
          "requirements/devops-wave1/README.md): maker-checker extends to PROJECTS ONLY — milestones/" +
          "risks/issues stay single-step hard deletes and are never routed through deletion_requests.",
        operationId: "requestProjectDeletion",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(ProjectDeleteRequestSchema),
        responses: {
          "202": { description: "Deletion request created (pending)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
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
          "the sprint is not currently active.",
        operationId: "closeSprint",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Closed sprint", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Sprint is not active", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
          "the sprint is closed.",
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
    "/timesheet-submissions": {
      get: {
        tags: ["timesheet-submissions"],
        summary: "List timesheet submissions",
        description: "scope: time:read. Filters: member_id, status (submitted|approved|rejected), period (= period_start exact match). Ordered submitted_at desc.",
        operationId: "listTimesheetSubmissions",
        parameters: [
          { name: "member_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "status", in: "query", schema: { type: "string", enum: ["submitted", "approved", "rejected"] } },
          { name: "period", in: "query", schema: { type: "string", format: "date" } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": { description: "Paginated timesheet submission list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["timesheet-submissions"],
        summary: "Submit a weekly timesheet for a member (four-eyes maker step, L-31)",
        description:
          "scope: time:submit. period_start must be a Monday; period_end is derived (+6 days). Snapshots " +
          "hours_total/entry_count from time_entries in that window at submit time — never recomputed " +
          "afterwards. 422 if the member has no time entries in the period (\"nothing to submit\"), or if " +
          "an open (submitted|approved) submission already exists for this member+period.",
        operationId: "submitTimesheet",
        requestBody: zodBody(createTimesheetSubmissionSchema),
        responses: {
          "201": { description: "Timesheet submission created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Resource member not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error, nothing to submit, or an open submission already exists", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/timesheet-submissions/{id}/decision": {
      post: {
        tags: ["timesheet-submissions"],
        summary: "Record an approve / reject / reopen decision on a timesheet submission (four-eyes checker step, L-31; reopen is R-76/L-32)",
        description:
          "scope: time:approve (a wildcard scope never grants it). decision is one of approved | rejected | reopened. " +
          "The deciding PERSON must differ from the submitter — compared on the submitter's principal " +
          "(the user, or the user who minted the submitting token) plus the legacy compound (id AND type) " +
          "comparison, guard symmetry across ALL THREE verbs; a token with no recorded owner can never " +
          "decide (403, code no_principal). approve/reject require status='submitted'; reopen requires the INVERSE — " +
          "status='approved' (reopen is the governed unlock for the period-close lock, R-76: an " +
          "approved week's time entries reject create/delete until reopened, migration " +
          "20260815000040). Rejection AND reopen both require a non-empty rationale; approval does not. " +
          "Reopen reverts status to 'submitted' and clears decided_by/_type/_label/decided_at/" +
          "decision_rationale, and notifies the workspace's approvers (the sheet re-enters the Review " +
          "Queue as a fresh approval request) rather than the submitter.",
        operationId: "decideTimesheetSubmission",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(timesheetDecisionSchema),
        responses: {
          "200": { description: "Decision recorded", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Self-decision rejected (four-eyes, code self_approval) — includes self-reopen; no recorded owner on the token (no_principal); or missing time:approve (forbidden_scope)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Already decided (approve/reject — code already_decided), not approved yet (reopen — code not_reopenable), or rationale missing on reject/reopen (code rationale_required)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
        ],
        responses: {
          "200": { description: "Paginated milestone list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["milestones"],
        summary: "Create a milestone under a project",
        description: "scope: milestone:write. 422 project_locked when the project is locked.",
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
        description: "scope: milestone:write. 422 project_locked when the patch touches a schedule-shape field (target_date/baseline_target_date) and the project is locked; status/etc. edits stay live under lock.",
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
        summary: "Delete a milestone",
        description: "scope: milestone:write. 422 project_locked when the project is locked.",
        operationId: "deleteMilestone",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "project_locked — the project is locked", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
        ],
        responses: {
          "200": { description: "Paginated task list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["tasks"],
        summary: "Create a task in a project",
        description: "scope: task:write. 422 project_locked when the project is locked.",
        operationId: "createTask",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
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
        description: "scope: task:write. Kanban status moves are audited. 422 project_locked when the patch touches a schedule-shape field (dates/estimate_hours/milestone_id) and the project is locked; status/checklist/assignee/etc. edits stay live under lock.",
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
        description: "scope: task:delete:request. Does NOT delete the task. Creates a deletion_request with status=pending. Returns 202. A different PERSON holding scope task:delete:approve must approve it (a token you minted counts as you). 422 project_locked when the project is locked (deletion always reshapes the schedule).",
        operationId: "requestTaskDeletion",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(TaskDeleteRequestSchema),
        responses: {
          "202": { description: "Deletion request created (pending)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
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
        ],
        responses: {
          "200": { description: "Paginated risk list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["risks"],
        summary: "Create a risk under a project",
        description: "scope: risk:write",
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
        description: "scope: risk:write",
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
        summary: "Delete a risk",
        description: "scope: risk:write",
        operationId: "deleteRisk",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
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
        ],
        responses: {
          "200": { description: "Paginated issue list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["issues"],
        summary: "Create an issue under a project",
        description: "scope: issue:write",
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
        description: "scope: issue:write",
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
        summary: "Delete an issue",
        description: "scope: issue:write",
        operationId: "deleteIssue",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
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
        description: "scope: resource:write",
        operationId: "deleteResource",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
        description: "scope: resource:write. Triggers over-allocation clash detection.",
        operationId: "createAllocation",
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
        description: "scope: resource:write. Re-runs over-allocation detection.",
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
    "/time-entries": {
      get: {
        tags: ["time-entries"],
        summary: "List time entries",
        description: "scope: time:read. Optional ?project_id, ?member_id, ?date_from/?date_to (entry_date window, inclusive) and ?billable filters.",
        operationId: "listTimeEntries",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
          { name: "project_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "member_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "date_from", in: "query", schema: { type: "string", format: "date" }, description: "entry_date >= date_from (inclusive)" },
          { name: "date_to", in: "query", schema: { type: "string", format: "date" }, description: "entry_date <= date_to (inclusive)" },
          { name: "billable", in: "query", schema: { type: "string", enum: ["true", "false"] }, description: "Exact match on the billable flag" },
        ],
        responses: {
          "200": { description: "Paginated time entry list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["time-entries"],
        summary: "Log a time entry",
        description:
          "scope: time:write. Cost is auto-computed as hours * member.cost_rate. 422 if the entry's " +
          "week already has an APPROVED timesheet submission for this member — the week is locked " +
          "(R-76/L-32; reopen the submission via POST /timesheet-submissions/{id}/decision with " +
          "decision='reopened' to unlock it).",
        operationId: "createTimeEntry",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["member_id", "project_id", "entry_date", "hours"], properties: { member_id: { type: "string", format: "uuid" }, project_id: { type: "string", format: "uuid" }, task_id: { type: "string", format: "uuid" }, entry_date: { type: "string", format: "date" }, hours: { type: "number", minimum: 0 }, note: { type: "string" }, billable: { type: "boolean", description: "L-29: whether this entry counts as billable. Omitted → defaults from the owning project's default_billable." } } } } } },
        responses: {
          "201": { description: "Time entry created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error, or the entry's week is locked (approved timesheet submission)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/time-entries/{id}": {
      delete: {
        tags: ["time-entries"],
        summary: "Delete a time entry",
        description:
          "scope: time:write. 422 if the entry's week already has an APPROVED timesheet submission for " +
          "this member — the week is locked (R-76/L-32; reopen the submission to unlock it).",
        operationId: "deleteTimeEntry",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "The entry's week is locked (approved timesheet submission)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/budget": {
      get: {
        tags: ["budget"],
        summary: "Get budget summary for a project",
        description: "scope: budget:read. Returns planned, committed, actual (computed from time_entries + expenses), variance, burn_pct.",
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
        description: "scope: budget:write",
        operationId: "upsertProjectBudget",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["planned_amount", "committed_amount"], properties: { planned_amount: { type: "number", minimum: 0 }, committed_amount: { type: "number", minimum: 0 }, currency: { type: "string", default: "USD" } } } } } },
        responses: {
          "200": { description: "Budget upserted", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        tags: ["budget"],
        summary: "Upsert budget for a project (alias for PUT)",
        description: "scope: budget:write",
        operationId: "patchProjectBudget",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { planned_amount: { type: "number", minimum: 0 }, committed_amount: { type: "number", minimum: 0 }, currency: { type: "string" } } } } } },
        responses: {
          "200": { description: "Budget upserted", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
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
        description: "scope: budget:write",
        operationId: "createExpense",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
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
        summary: "Delete an expense",
        description: "scope: budget:write",
        operationId: "deleteExpense",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/deletion-requests": {
      get: {
        tags: ["deletion-requests"],
        summary: "List deletion requests",
        description: "scope: task:read or audit:read. Optional ?status filter (pending|approved|rejected|committed|withdrawn).",
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
          "scope: task:delete:approve for target_type=task, project:delete:approve for target_type=project " +
          "(per-type gate, resolved from the loaded request; a wildcard scope never grants it). Four-eyes " +
          "compares PEOPLE: the approver must be a different person from the requester — a token counts as " +
          "the user who minted it, so you cannot approve with your own token what you (or any of your tokens) " +
          "requested (403, code self_approval); a token with no recorded owner can never approve (403, code " +
          "no_principal). Optional body { note }: the approver's note, recorded in the audit row of the " +
          "decision (an empty body is fine). " +
          "Dispatches by target_type to the matching atomic commit RPC " +
          "(nopm_commit_task_deletion / nopm_commit_project_deletion) — deletes the target and commits " +
          "the request in one transaction. " +
          "For target_type=project, also 422s if the project's schedule was frozen " +
          "after the deletion was requested (message: Project is locked).",
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
          "403": { description: "Missing the per-type approve scope (forbidden_scope); the approver is the same person as the requester (self_approval); or the token has no recorded owner (no_principal)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Request already decided (already_decided), the project is locked (target_type=project, schedule frozen since the request was made), or validation error (note too long)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/deletion-requests/{id}/reject": {
      post: {
        tags: ["deletion-requests"],
        summary: "Reject a pending deletion request (checker step)",
        description: "scope: task:delete:approve for task requests, project:delete:approve for project requests (per-type gate; a wildcard scope never grants it). Four-eyes compares PEOPLE: the decider must be a different person from the requester. Self-rejection by the SAME actor returns 422 (code self_approval); the same person through ANOTHER identity (e.g. a token they minted) returns 403 (code self_approval); a token with no recorded owner returns 403 (code no_principal). A maker cancels their own request via /withdraw instead.",
        operationId: "rejectDeletionRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string", maxLength: 1000 } } } } } },
        responses: {
          "200": { description: "Request rejected — { data: { rejected: true } }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Missing the per-type approve scope (forbidden_scope); the same person as the requester through another identity (self_approval); or no recorded owner (no_principal)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Request already decided (already_decided), self-rejection by the same actor (self_approval), or validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/deletion-requests/{id}/withdraw": {
      post: {
        tags: ["deletion-requests"],
        summary: "Withdraw your own pending deletion request (maker step)",
        description: "scope: task:delete:request for a task request, project:delete:request for a project request (per-type maker gate). Only the ORIGINAL requester (the same actor) may withdraw, and only while the request is pending. Cancels the request without a checker decision — the one self-act four-eyes permits; audited as deletion_request.withdrawn.",
        operationId: "withdrawDeletionRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Request withdrawn", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Caller is not the original requester, or lacks the per-type maker scope", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
          "?channel (R-82: one of ui|api|cli|mcp|assistant, unrecognized values ignored). " +
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
          "external_event_id and external_actor_ref — all SERVER-DERIVED from the verified connector binding, " +
          "never accepted from X-NoPM-Client. The ?channel filter recognises only the five declarable values " +
          "(ui|api|cli|mcp|assistant); `lark` is not one of them, so ?channel=lark is currently ignored like any " +
          "unrecognized value — filter on ?action=... or inspect the channel field of returned rows instead.",
        operationId: "listAuditLog",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 50, minimum: 1, maximum: 100 } },
          { name: "target_type", in: "query", schema: { type: "string" } },
          { name: "target_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "action", in: "query", schema: { type: "string" } },
          { name: "actor_id", in: "query", schema: { type: "string" } },
          { name: "channel", in: "query", schema: { type: "string", enum: ["ui", "api", "cli", "mcp", "assistant", "lark"] } },
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
    "/export": {
      get: {
        tags: ["export"],
        summary: "Governed CSV export (L-27 / L-36)",
        description:
          "Requires the entity's read scope (task:read, risk:read, issue:read, clash:read, " +
          "audit:read, time:read, program:read, or project:read). Streams text/csv with Content-Disposition " +
          "nopm-<entity>-<date>.csv (date is server-derived, never from request input). " +
          "Filter/sort params are the SAME ones the entity's list API takes (single source of " +
          "truth, so a filter honored in a list view is always honored the same way in its " +
          "export): tasks accept project_id/assignee_id/status_type/priority/" +
          "due_before/due_after/overdue/q/sort; risks/issues take an OPTIONAL project_id (omitted = every risk/issue in the workspace, " +
          "for cross-project registers) plus status/severity(/priority for issues)/q (title ilike)/sort; projects accept " +
          "rag_status/phase/program_id/q (name ilike)/sort (name|code|rag_status|phase|completion_pct|target_date|created_at); clashes take no " +
          "filters (fixed created_at desc, matching GET /clashes); time_entries accept " +
          "project_id/member_id/date_from/date_to/billable; audit accepts " +
          "target_type/target_id/action/actor_id/channel (R-82)/since/order (R-85, leniently: an " +
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
          { name: "entity", in: "query", required: true, schema: { type: "string", enum: ["tasks", "risks", "issues", "clashes", "audit", "time_entries", "programs", "projects"] } },
          { name: "project_id", in: "query", schema: { type: "string", format: "uuid" }, description: "Optional filter for entity=tasks|risks|issues|time_entries (risks/issues: omitted = whole workspace; a project outside the workspace 404s)" },
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
          { name: "member_id", in: "query", schema: { type: "string", format: "uuid" }, description: "entity=time_entries" },
          { name: "date_from", in: "query", schema: { type: "string", format: "date" }, description: "entity=time_entries (entry_date >=, inclusive)" },
          { name: "date_to", in: "query", schema: { type: "string", format: "date" }, description: "entity=time_entries (entry_date <=, inclusive)" },
          { name: "billable", in: "query", schema: { type: "string", enum: ["true", "false"] }, description: "entity=time_entries" },
          { name: "target_type", in: "query", schema: { type: "string" }, description: "entity=audit" },
          { name: "target_id", in: "query", schema: { type: "string" }, description: "entity=audit" },
          { name: "action", in: "query", schema: { type: "string" }, description: "entity=audit" },
          { name: "actor_id", in: "query", schema: { type: "string" }, description: "entity=audit" },
          { name: "channel", in: "query", schema: { type: "string", enum: ["ui", "api", "cli", "mcp", "assistant", "lark"] }, description: "entity=audit (R-82)" },
          { name: "since", in: "query", schema: { type: "string", format: "date-time" }, description: "entity=audit (R-85, lenient — a bad value is dropped, not 422)" },
          { name: "order", in: "query", schema: { type: "string", enum: ["asc", "desc"] }, description: "entity=audit (R-85, lenient — an unrecognized value is dropped, not 422)" },
        ],
        responses: {
          "200": { description: "CSV file (RFC 4180, CRLF, BOM, header always present)", content: { "text/csv": { schema: { type: "string" } } } },
          "403": { description: "Forbidden — missing the entity's read scope", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Invalid/missing entity, or an invalid sort field", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "project_id not found in this workspace (entity=risks|issues)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/mfa": {
      get: {
        tags: ["auth"],
        summary: "Get MFA status for the current user",
        description: "scope: user session only. Returns { enabled, enrolled, satisfied }; satisfied is true once the MFA challenge cookie for this session is valid (R-91).",
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
        description: "scope: user session only. Exempt from the MFA-challenge gate itself. Rate-limited: 5 failed attempts / 10 min / user. On success sets the signed HttpOnly nopm_mfa cookie (max 12h, never outliving the session).",
        operationId: "challengeMfa",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string", description: "6-digit TOTP code, or a 32-char backup code (consumed on use)" } } } } } },
        responses: {
          "200": { description: "Challenge passed; nopm_mfa cookie set", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Invalid code, or MFA not enabled for this account", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "Too many attempts (5 / 10 min)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/auth/mfa/enroll": {
      post: {
        tags: ["auth"],
        summary: "Begin TOTP enrollment — returns secret and otpauth URI",
        description: "scope: user session only",
        operationId: "enrollMfa",
        responses: {
          "200": { description: "Enrollment started (secret + otpauth)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
        },
      },
    },
    "/auth/mfa/verify": {
      post: {
        tags: ["auth"],
        summary: "Confirm TOTP code, enable MFA, receive backup codes",
        description: "scope: user session only",
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
        description: "scope: user session only",
        operationId: "disableMfa",
        responses: {
          "200": { description: "MFA disabled", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
        },
      },
    },
    "/auth/signout": {
      post: {
        tags: ["auth"],
        summary: "Sign out the current session",
        description: "No auth required. Clears the server-side Supabase cookie session. Always succeeds.",
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
          "No auth required. Signs in with the pre-seeded demo account (credentials in server-only env vars DEMO_EMAIL / DEMO_PASSWORD) and redirects to /dashboard. Returns 503 if the demo account is not configured, 302 to /login?error=demo_unavailable on auth failure.",
        security: [],
        operationId: "demoLogin",
        responses: {
          "302": { description: "Redirect to /dashboard (session cookies set)" },
          "503": { description: "Demo account not configured on this deployment" },
        },
      },
    },
    "/timeline": {
      get: {
        tags: ["system"],
        summary: "Portfolio timeline graph",
        description: "scope: project:read. Returns the full governed timeline graph for the workspace (projects, milestones, tasks, risks, issues).",
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
        description: "Session-user only. Runs the agentic assistant loop and returns the reply plus any actions taken.",
        operationId: "assistantChat",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["message"], properties: { message: { type: "string" }, history: { type: "array", items: { type: "object", required: ["role", "content"], properties: { role: { type: "string", enum: ["user", "assistant"] }, content: { type: "string" } } } } } } } } },
        responses: {
          "200": { description: "{ reply, actions, usedDemoKey }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Token actors not allowed", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
        description: "scope: document:read. Optional filters: ?project_id, ?folder, ?status, ?doc_type.",
        operationId: "listDocuments",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
          { name: "project_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "folder", in: "query", schema: { type: "string" } },
          { name: "status", in: "query", schema: { type: "string" } },
          { name: "doc_type", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Paginated document list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["documents"],
        summary: "Create a document",
        description: "scope: document:write. Auto-assigns a DOC-NNN reference_id.",
        operationId: "createDocument",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["title", "doc_type"], properties: { title: { type: "string" }, doc_type: { type: "string" }, project_id: { type: "string", format: "uuid" }, folder: { type: "string" }, status: { type: "string" }, summary: { type: "string" }, body: { type: "string" }, external_url: { type: "string" }, owner_id: { type: "string", format: "uuid" } } } } } },
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
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" }, doc_type: { type: "string" }, project_id: { type: "string", format: "uuid" }, folder: { type: "string" }, status: { type: "string" }, summary: { type: "string" }, body: { type: "string" }, external_url: { type: "string" }, owner_id: { type: "string", format: "uuid" } } } } } },
        responses: {
          "200": { description: "Updated document", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["documents"],
        summary: "Delete a document",
        description: "scope: document:write",
        operationId: "deleteDocument",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
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
        description: "scope: document:write. Call after the browser uploads bytes to the signed upload URL. Body: { path, file_name, mime_type, file_size }.",
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
        description: "scope: document:write. Deletes the storage object and clears the metadata columns.",
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
        description: "scope: document:write. Returns a short-lived Supabase Storage signed upload URL. Max file size 25 MiB.",
        operationId: "signDocumentFileUpload",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["file_name", "mime_type", "file_size"], properties: { file_name: { type: "string" }, mime_type: { type: "string", description: "Declared type. Browser-executable types (html, svg, xml, js) are stored as application/octet-stream; inline-rendered types (pdf, png, jpeg, gif, webp) are verified against the uploaded bytes on attach (422 on mismatch); other types are served as downloads." }, file_size: { type: "integer", description: "Bytes, max 26214400 (25 MiB)" } } } } } },
        responses: {
          "200": { description: "{ signedUrl, token, path }", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error or file too large", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
          "scope: change:write. Auto-assigns a CR-NNN reference_id. Only `title` is required (category defaults to " +
          "scope, priority to medium, status to raised). `status` may only be raised or under_review: every terminal " +
          "status needs a decider, so approved / rejected / deferred / implemented are reached through " +
          "POST /change-requests/{id}/decision — sending one at creation is a 422 validation error, never a raw " +
          "database error.",
        operationId: "createChangeRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(createChangeRequestSchema),
        responses: {
          "201": { description: "Change request created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error — including a status other than raised | under_review", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
        description: "scope: change:write. `status` is NOT updatable here — every status transition goes through the four-eyes POST /change-requests/{id}/decision.",
        operationId: "updateChangeRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(updateChangeRequestSchema),
        responses: {
          "200": { description: "Updated change request", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["change-requests"],
        summary: "Delete a change request",
        description: "scope: change:write",
        operationId: "deleteChangeRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
          "racing cannot both win (the loser gets 422 already_decided). rationale is required.",
        operationId: "decideChangeRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(decisionActionSchema),
        responses: {
          "200": { description: "Decision recorded (the updated change request)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Self-approval rejected (code self_approval), token has no recorded owner (no_principal), or missing change:decide (forbidden_scope)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
        description: "scope: decision:write. Auto-assigns a DEC-NNN reference_id.",
        operationId: "createDecision",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["title", "status"], properties: { title: { type: "string" }, context: { type: "string" }, options: { type: "string" }, decision: { type: "string" }, rationale: { type: "string" }, status: { type: "string" }, decided_at: { type: "string", format: "date-time" }, supersedes: { type: "string", format: "uuid" }, source: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,39}$", description: "System of work this record mirrors (e.g. jira, slack, teams); NoPM is the governed record beside it" }, external_ref: { type: "string", minLength: 1, maxLength: 200 }, external_url: { type: "string", format: "uri", maxLength: 2000 } } } } } },
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
        description: "scope: decision:write",
        operationId: "updateDecision",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" }, context: { type: "string" }, options: { type: "string" }, decision: { type: "string" }, rationale: { type: "string" }, status: { type: "string" }, decided_at: { type: "string", format: "date-time" }, supersedes: { type: "string", format: "uuid" }, source: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,39}$", description: "System of work this record mirrors (e.g. jira, slack, teams); NoPM is the governed record beside it" }, external_ref: { type: "string", minLength: 1, maxLength: 200 }, external_url: { type: "string", format: "uri", maxLength: 2000 } } } } } },
        responses: {
          "200": { description: "Updated decision", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["decisions"],
        summary: "Delete a decision",
        description: "scope: decision:write",
        operationId: "deleteDecision",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/lock": {
      post: {
        tags: ["projects"],
        summary: "Lock a project timeline",
        description: "scope: project:write. Sets is_locked=true, records locked_by/locked_at/lock_reason. Snapshots baseline dates for milestones and tasks if not yet baselined.",
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
        description: "scope: project:write. Clears is_locked, locked_by, locked_at, lock_reason. reason is REQUIRED (R-83 governed unlock) and is recorded in the audit trail's after payload (unlock_reason), not stored on the row.",
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
        description: "scope: project:write. If the project is locked, status is pending_approval; otherwise draft.",
        operationId: "createRebaseline",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["reason"], properties: { reason: { type: "string" }, before: { type: "object" }, after: { type: "object" } } } } } },
        responses: {
          "201": { description: "Rebaseline created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
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
          "rebaseline); a token with no recorded owner cannot vote (403, code no_principal).",
        operationId: "signoffRebaseline",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(signoffSchema),
        responses: {
          "200": { description: "Signoff recorded; rebaseline status may update ({ signoff, rebaseline })", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Self-signoff by the same person via another identity (self_approval), no recorded owner on the token (no_principal), or missing rebaseline:approve (forbidden_scope)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error, or the requester signing off their own rebaseline as the same user (self_approval)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/rebaselines/{id}/apply": {
      post: {
        tags: ["rebaselines"],
        summary: "Apply an approved rebaseline (four-eyes)",
        description: "scope: rebaseline:approve (a wildcard never grants it). Only approved rebaselines may be applied. The requester may not apply their own rebaseline — compared on the person, so a token the requester minted is refused too (403, code self_approval; the legacy same-user case is a 422 with the same code); a token with no recorded owner cannot apply (403, code no_principal). Overwrites baseline dates for all milestones and tasks in the project.",
        operationId: "applyRebaseline",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Rebaseline applied", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Self-apply by the same person via another identity (self_approval), no recorded owner on the token (no_principal), or missing rebaseline:approve (forbidden_scope)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "The requester applying their own rebaseline as the same user (self_approval), or the rebaseline is not in status approved", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
          "scope: task:read or audit:read or change:read or time:read or project:read. Any ONE of these opens the " +
          "endpoint, but each kind is shown only if the caller could read it through that family's own list endpoint " +
          "(task_deletion / project_deletion: task:read or audit:read; change_request: change:read; timesheet: time:read; " +
          "rebaseline: project:read). Kinds the caller cannot read are named in `hidden_kinds`, so an EMPTY list is not " +
          "proof that nothing is pending; a caller who can read none of them gets 403. A signed-in user sees every kind. " +
          "Lists every governed decision currently waiting in the workspace, oldest first: deletion requests " +
          "(task + project), change requests (raised / under_review), submitted timesheets and rebaselines awaiting " +
          "sign-off. READ-ONLY — there is no way to decide anything here: each item says whether the caller `can_decide` it " +
          "(the decide scope AND four-eyes by person) and, when not, `reason_if_not`; the decision itself is made by a " +
          "person in the console, on a Lark card, or with the existing decision routes. Items the caller raised are still " +
          "listed, flagged as ones it cannot decide. `can_decide` is advisory — the decision routes re-check everything. " +
          "`total` is the exact count across the kinds the caller can read; paging reaches at most the oldest 1000 items " +
          "per kind. Also available as the MCP / assistant tool list_pending_approvals and as `nopm review` in the CLI.",
        operationId: "listPendingApprovals",
        parameters: [
          {
            name: "kind",
            in: "query",
            style: "form",
            explode: false,
            schema: { type: "array", items: { type: "string", enum: [...PENDING_KINDS] } },
            description:
              "Restrict to these kinds — comma-separated (kind=timesheet,rebaseline) or repeated. Default: every kind the " +
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
        summary: "List my calendar feeds",
        description:
          "scope: milestone:read. The caller's OWN active (non-revoked) milestone calendar feeds, newest first. The " +
          "subscription URL is never returned here — it is shown once, by POST. A token with no recorded owner owns no " +
          "feeds and lists none.",
        operationId: "listCalendarFeeds",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": { description: "Paginated calendar feed list (CalendarFeed[])", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
          "403": { description: "Missing milestone:read", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["calendar"],
        summary: "Create a milestone calendar feed",
        description:
          "scope: milestone:write (viewers are refused). Mints a read-only iCalendar feed of milestone target dates " +
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
          "403": { description: "Missing milestone:write, a viewer, or a token with no recorded owner", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
          "(stable UID milestone-<id>@<host>, SEQUENCE from updated_at, a deep link in URL), limited to the feed's " +
          "workspace and, if set, project. Cache-Control: private, max-age=900 and Referrer-Policy: no-referrer. " +
          "Unknown, malformed and revoked tokens all get the same 404, so the response cannot be used to probe which " +
          "tokens exist. Not audited per fetch (a calendar polls every few minutes); the feed's last_fetched_at is " +
          "updated after the response. Create the URL with POST /calendar-feeds.",
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
        ],
        responses: {
          "200": {
            description: "iCalendar document (CRLF line endings, 75-octet folding)",
            headers: {
              "Cache-Control": { schema: { type: "string" }, description: "private, max-age=900" },
              "Referrer-Policy": { schema: { type: "string" }, description: "no-referrer" },
            },
            content: { "text/calendar": { schema: { type: "string" } } },
          },
          "404": { description: "Unknown, malformed or revoked feed token (one uniform response)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
          "has_verification_token, has_encrypt_key, has_relay_secret, tenant_pinned), the non-secret config, and the " +
          "callback_urls to paste into the platform console; never a secret value, ciphertext or hash. Any OTHER member, " +
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
          "a second returns 422 (code connector_exists) until the first is revoked. app_secret, verification_token and the " +
          "optional encrypt_key are encrypted at rest and NEVER returned by any API. The relay secret used by the self-host " +
          "worker (mode long_connection) is generated here and returned exactly once as `relay_secret` — store it now; only " +
          "its hash is kept. digest.chat_id is required when digest.enabled. Audited as integration.connector.create " +
          "(the audit row carries the masked view, never a secret).",
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
          "422": { description: "Validation error, or a live connector already exists in this workspace (code connector_exists)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
          "pinned by the next first account link, or rotate_relay_secret to mint a new relay secret (returned once as " +
          "`relay_secret`; the old one stops working). Revoking is DELETE, not a status here. At least one field is " +
          "required. Audited as integration.connector.update — the row records WHICH secrets changed, never their values.",
        operationId: "updateIntegrationConnector",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(updateConnectorSchema),
        responses: {
          "200": { description: "Updated connector (the masked view, without callback_urls); includes `relay_secret` once when rotate_relay_secret was set", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Not an admin user session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Validation error; the connector is revoked (code connector_revoked); or the stored credentials cannot be read and only part of them was sent (code secrets_unreadable)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
          "(integration.digest.send, trigger manual). A manual send never occupies the once-per-ISO-week scheduled slot. " +
          "The connector must be active and have a digest chat id.",
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
          "is audited as integration.identity.link with channel lark.",
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
    "/integrations/cron": {
      get: {
        tags: ["integrations"],
        summary: "Daily scheduler tick (host cron only)",
        description:
          "NOT a user or PAT route. The only credential is Authorization: Bearer <CRON_SECRET> — the deployment's CRON_SECRET " +
          "environment variable, which the host's cron scheduler attaches to its own calls — compared in constant time; an " +
          "unset CRON_SECRET authorises nobody. For every ACTIVE connector (paused and revoked ones are skipped entirely) " +
          "it drains deliveries that are due for retry and posts the weekly digest on the connector's configured weekday " +
          "(UTC), once per ISO week. Idempotent: a second call the same day re-drains (leases prevent double sends) and " +
          "never repeats a digest. Runs daily at 01:00 UTC per vercel.json.",
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
                          },
                        },
                        digests: {
                          type: "object",
                          properties: { sent: { type: "integer" }, skipped: { type: "integer" }, failed: { type: "integer" } },
                        },
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
          "console fields also works). Any other event -> {}. Unknown, paused or revoked connectors are a bare 404 and " +
          "every verification failure is the same generic 401 (the reason is logged server-side only), so the endpoint " +
          "is neither a connector-existence nor a decryption oracle. Authenticated requests are limited to 300/min per " +
          "connector (NOPM_RATE_LARK_PER_MIN); failed verifications are capped separately.",
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
          "401": { description: "Verification failed (bad signature, stale timestamp, undecryptable body or wrong verification token) — one generic body { error: \"Invalid request\" }", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "403": { description: "The connector is not in webhook mode (code wrong_mode) — only returned to an authenticated caller", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Malformed id, or an unknown, paused or revoked connector — { error: \"Not found\" }", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "413": { description: "Body larger than 256 KiB", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "Per-connector budget exceeded, or too many failed verifications — Retry-After header gives the seconds", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "500": { description: "The connector's stored credentials cannot be read — { error: \"Connector is misconfigured\" }", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
          "audit row with channel lark. No linked account, an expired or spent card, a non-recipient, a self-approval or an " +
          "already-decided request are each answered with a toast, never an HTTP error. Replies HTTP 200 within the " +
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
          "401": { description: "Verification failed — one generic body { error: \"Invalid request\" }", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "403": { description: "The connector is not in webhook mode (code wrong_mode)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Malformed id, or an unknown, paused or revoked connector", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "413": { description: "Body larger than 256 KiB", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "Too many failed verifications — Retry-After header gives the seconds", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "500": { description: "The connector's stored credentials cannot be read", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
          "Limits: 120/min per client IP (before authentication) and 600/min per connector; a rate-limited CARD click is " +
          "answered 200 with a toast instead of an error.",
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
          "401": { description: "Bad signature or missing headers (code invalid_relay_signature), timestamp outside +/-300 s (stale_relay_timestamp), or the connector has no relay secret (no_relay_secret)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "403": { description: "The connector is not active (connector_inactive) or not in long_connection mode (wrong_mode) — only revealed to an authenticated caller", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Malformed id or unknown connector (code connector_not_found)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "413": { description: "Body larger than 256 KiB (code body_too_large)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Not valid JSON, wrong shape (fields lists the problems), or type does not match the event type (code invalid_relay_request)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "Rate limit exceeded (code rate_limited)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "500": { description: "The connector's stored credentials cannot be read (code connector_misconfigured)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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

export const GET = route(async () => Response.json(spec), { auth: false });

// Exported for the openapi-coverage drift test only.
// Do NOT import this in production application code.
export const specForTesting = spec;

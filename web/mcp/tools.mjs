/**
 * NoPM agent tool registry — the SINGLE source of truth for every agent surface.
 *
 * Consumed by:
 *   - web/mcp/server.mjs            (MCP stdio server — plain Node, no build step)
 *   - web/src/lib/assistant/tools.ts (in-app BYOK assistant — typed re-export)
 *
 * Every tool maps 1:1 to a documented REST endpoint. Field names, required
 * lists, and enums are locked to the API's Zod validators by
 * web/src/lib/assistant/tools-zod.test.ts — edit a validator without editing
 * this file (or vice versa) and that test fails.
 *
 * Contract notes:
 *   - `toRequest` must never throw on empty args ({}): fallback.ts derives its
 *     read-only tool set by probing `toRequest({}).method`.
 *   - Enums are real JSON-Schema `enum` arrays, not prose — providers enforce
 *     them at generation time, which prevents most 422s before they happen.
 */

// ── Enums (mirrored from the API's Zod validators; locked by tools-zod.test.ts) ──

export const PROJECT_RAG_STATUSES = ["not_started", "red", "amber", "green", "complete"];
export const TASK_STATUS_TYPES = ["backlog", "unstarted", "started", "completed", "canceled"];
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"];
export const MILESTONE_STATUSES = ["not_started", "on_track", "at_risk", "delayed", "completed"];
export const RISK_LEVELS = ["low", "medium", "high", "critical"];
export const RISK_STATUSES = ["open", "mitigating", "closed", "accepted"];
export const ISSUE_PRIORITIES = ["low", "medium", "high", "urgent"];
export const ISSUE_STATUSES = ["open", "in_progress", "resolved", "closed"];
export const ISSUE_SEVERITIES = ["low", "medium", "high", "critical"];
// Mirrors AuditChannel in web/src/lib/audit/channel.ts (R-82/R-85) — the
// six channel values audit_log's DB check constraint accepts ("lark" is
// server-derived for chat-card decisions; it can be filtered on, never declared).
export const AUDIT_CHANNELS = ["ui", "api", "cli", "mcp", "assistant", "lark"];
// Mirrors PENDING_KINDS in web/src/lib/review/pending.ts (the GET /api/review
// `kind` filter); the first four are the kinds the governed decision path
// accepts. Locked by web/src/lib/review/tool.test.ts.
export const PENDING_APPROVAL_KINDS = [
  "task_deletion",
  "project_deletion",
  "change_request",
  "rebaseline",
];

const DATE = "ISO date, YYYY-MM-DD";
const DATETIME = "ISO 8601 datetime with timezone, e.g. 2026-09-30T00:00:00Z";

const page = { type: "number", description: "Page number (default 1)" };
const limit = { type: "number", description: "Results per page (default 20, max 100)" };

// ── Complement seam (0041, R-81) — mirrors the create/update Zod validators
// exactly (source pattern, external_ref maxLength 200, external_url uri). NoPM
// does not replace Jira/Slack/Teams; it is the governed record beside them.
const source = {
  type: "string",
  pattern: "^[a-z0-9][a-z0-9_-]{0,39}$",
  description: "System of work this record mirrors, e.g. jira, slack, teams",
};
const externalRef = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  description: "The id/key of this record in the external system (e.g. a Jira issue key)",
};
const externalUrl = {
  type: "string",
  format: "uri",
  maxLength: 2000,
  description: "Optional link to the record in the external system",
};

// ── Optimistic concurrency (R-90) — mirrors the update Zod validators exactly
// (ISO 8601 datetime with offset). Opt-in: omit it for today's last-write-wins
// behavior; send the updated_at you last read to get a 412 instead of
// silently overwriting a concurrent edit.
const expectedUpdatedAt = {
  type: "string",
  format: "date-time",
  description:
    "Optional optimistic-concurrency guard: pass the updated_at you last read on this record. " +
    "If the record has changed since, the update is rejected with a 412 instead of overwriting it.",
};

// ── Path safety ───────────────────────────────────────────────────────────
//
// A tool argument is model- (or prompt-injection-) controlled text, and it used
// to be interpolated straight into the request path: `project_id =
// "<uuid>/../unlock?x="` turned `create_milestone` into POST
// /api/projects/<uuid>/unlock, a route that is not a tool at all. Two layers:
//
//   1. every id that lands in a path goes through idSeg(): it must be a UUID
//      and is encodeURIComponent-ed; anything else throws ToolArgError BEFORE a
//      request is built (the MCP server and /api/mcp already turn a throw into
//      a "Bad arguments" tool result);
//   2. every finished request is checked against the SHAPE of its own tool's
//      route (guardTool below), so even a future tool that forgets idSeg()
//      cannot reach a different route.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** All-zero UUID: stands in for an id the caller did not send (see idSeg). */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Thrown when a tool argument cannot be placed in a request safely. */
export class ToolArgError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolArgError";
  }
}

/**
 * Path segment for an id argument. A present value must be a UUID. An ABSENT
 * value must not throw: `toRequest({})` is probed at import time to learn each
 * tool's method (fallback.ts), so a missing id becomes the nil UUID, which the
 * API answers with a clean 404 instead of a request for a made-up route.
 */
function idSeg(name, value) {
  if (value === undefined || value === null) return NIL_UUID;
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new ToolArgError(`${name} must be a UUID`);
  }
  return encodeURIComponent(value);
}

/** Query-string value for page / limit: never throws, can never add a parameter or a path part. */
function qnum(value, fallback) {
  return encodeURIComponent(String(value ?? fallback));
}

/** Path with every UUID segment replaced by ":id" — the route shape. */
function routeShape(path) {
  const cut = path.indexOf("?");
  const pathname = cut === -1 ? path : path.slice(0, cut);
  return pathname
    .split("/")
    .map((seg) => (UUID_RE.test(seg) ? ":id" : seg))
    .join("/");
}

/** Plain, already-normalised /api path: lower-case route words and ids, nothing else. */
const SAFE_PATHNAME = /^\/api(\/[A-Za-z0-9-]+)+$/;
/** Printable ASCII, no spaces: no control characters, backslashes or fragments sneak in. */
const PRINTABLE = /^[\x21-\x7e]+$/;

/**
 * @typedef {{ path: string, method: string, body?: unknown }} ToolRequest
 * @typedef {{
 *   name: string,
 *   description: string,
 *   parameters: Record<string, unknown>,
 *   toRequest: (args: Record<string, any>) => ToolRequest
 * }} ToolRegistryEntry
 */

/** @type {ToolRegistryEntry[]} */
const RAW_TOOLS = [
  // ── Projects ─────────────────────────────────────────────────────────────
  {
    name: "list_projects",
    description: "List all projects in the workspace.",
    parameters: {
      type: "object",
      properties: { page, limit },
      required: [],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/projects?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}`,
      method: "GET",
    }),
  },
  {
    name: "get_project",
    description: "Get a single project by id, including charter fields, RAG status, and dates.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" } },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({ path: `/api/projects/${idSeg("project_id", args.project_id)}`, method: "GET" }),
  },
  {
    name: "create_project",
    description: "Create a new project in the workspace. `code` is a short unique identifier shown throughout the UI.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "Short unique project code, 1-32 chars, e.g. APOLLO" },
        name: { type: "string", description: "Project name" },
        description: { type: "string", description: "Optional description" },
        rag_status: { type: "string", enum: PROJECT_RAG_STATUSES },
        start_date: { type: "string", description: DATE },
        target_date: { type: "string", description: DATE },
        currency: { type: "string", description: "3-letter ISO currency code, e.g. USD" },
        source,
        external_ref: externalRef,
        external_url: externalUrl,
      },
      required: ["code", "name"],
      additionalProperties: false,
    },
    toRequest: (args) => ({ path: "/api/projects", method: "POST", body: args }),
  },
  {
    name: "update_project",
    description: "Update a project's fields (name, RAG status, completion, dates). Audited.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        name: { type: "string" },
        description: { type: "string" },
        rag_status: { type: "string", enum: PROJECT_RAG_STATUSES },
        completion_pct: { type: "number", description: "0-100" },
        start_date: { type: "string", description: DATE },
        target_date: { type: "string", description: DATE },
        source,
        external_ref: externalRef,
        external_url: externalUrl,
        expected_updated_at: expectedUpdatedAt,
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const { project_id, ...body } = args;
      return { path: `/api/projects/${idSeg("project_id", project_id)}`, method: "PATCH", body };
    },
  },
  {
    name: "request_project_deletion",
    description:
      "Request deletion of a project. Does NOT delete immediately — creates a maker-checker " +
      "deletion request (status=pending, target_type=project) that must be approved by a " +
      "DIFFERENT actor holding scope project:delete:approve. Self-approval is rejected by the " +
      "server. Mirrors request_task_deletion; owner-locked (Decision 3, devops-wave1) — this " +
      "four-eyes flow covers PROJECTS ONLY, not milestones/risks/issues (those stay single-step " +
      "hard deletes).",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        reason: { type: "string", description: "Reason for deletion (required — goes to the audit trail)" },
      },
      required: ["project_id", "reason"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/projects/${idSeg("project_id", args.project_id)}`,
      method: "DELETE",
      body: { reason: args.reason },
    }),
  },

  // ── Milestones ────────────────────────────────────────────────────────────
  {
    name: "list_milestones",
    description: "List milestones for a project.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" }, page, limit },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/projects/${idSeg("project_id", args.project_id)}/milestones?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}`,
      method: "GET",
    }),
  },
  {
    name: "create_milestone",
    description: "Create a milestone inside a project.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        name: { type: "string", description: "Milestone name" },
        description: { type: "string" },
        target_date: { type: "string", description: DATETIME },
        status: { type: "string", enum: MILESTONE_STATUSES },
        completion_pct: { type: "number", description: "0-100 integer" },
        deliverable: { type: "string", description: "What this milestone delivers" },
      },
      required: ["project_id", "name"],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const { project_id, ...body } = args;
      return { path: `/api/projects/${idSeg("project_id", project_id)}/milestones`, method: "POST", body };
    },
  },
  {
    name: "update_milestone",
    description:
      "Update a milestone (status, target date, completion). Audited. Completing a milestone that still has open tasks " +
      "returns 422 open_tasks (\"N tasks are still open. Complete this milestone anyway?\"): if the person confirms, resend " +
      "the same call with confirm_open_tasks: true.",
    parameters: {
      type: "object",
      properties: {
        milestone_id: { type: "string", description: "Milestone UUID" },
        name: { type: "string" },
        description: { type: "string" },
        target_date: { type: "string", description: DATETIME },
        status: { type: "string", enum: MILESTONE_STATUSES },
        completion_pct: { type: "number", description: "0-100 integer" },
        confirm_open_tasks: {
          type: "boolean",
          description: "Set true to complete the milestone although tasks are still open (resend after a 422 open_tasks). Never stored.",
        },
        expected_updated_at: expectedUpdatedAt,
      },
      required: ["milestone_id"],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const { milestone_id, ...body } = args;
      return { path: `/api/milestones/${idSeg("milestone_id", milestone_id)}`, method: "PATCH", body };
    },
  },

  // ── Tasks ─────────────────────────────────────────────────────────────────
  {
    name: "list_tasks",
    description: "List tasks for a project.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" }, page, limit },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/projects/${idSeg("project_id", args.project_id)}/tasks?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}`,
      method: "GET",
    }),
  },
  {
    name: "get_task",
    description: "Get a single task by id, including status, assignee, estimates, and checklist.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string", description: "Task UUID" } },
      required: ["task_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({ path: `/api/tasks/${idSeg("task_id", args.task_id)}`, method: "GET" }),
  },
  {
    name: "create_task",
    description: "Create a task inside a project. status_type defaults to backlog, priority to medium.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        name: { type: "string", description: "Task name" },
        description: { type: "string" },
        status_type: { type: "string", enum: TASK_STATUS_TYPES },
        priority: { type: "string", enum: TASK_PRIORITIES },
        assignee_id: { type: "string", description: "Profile UUID of assignee" },
        milestone_id: { type: "string", description: "Milestone UUID" },
        start_date: { type: "string", description: DATE },
        due_date: { type: "string", description: DATE },
        estimate_hours: { type: "number" },
        story_points: { type: "number" },
        acceptance_criteria: { type: "string" },
        source,
        external_ref: externalRef,
        external_url: externalUrl,
      },
      required: ["project_id", "name"],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const { project_id, ...body } = args;
      return { path: `/api/projects/${idSeg("project_id", project_id)}/tasks`, method: "POST", body };
    },
  },
  {
    name: "update_task",
    description:
      "Update a task. Changing status_type IS the governed Kanban move — every change writes an immutable audit row.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task UUID" },
        name: { type: "string" },
        description: { type: "string" },
        status_type: { type: "string", enum: TASK_STATUS_TYPES },
        priority: { type: "string", enum: TASK_PRIORITIES },
        assignee_id: { type: "string", description: "Profile UUID of assignee" },
        milestone_id: { type: "string", description: "Milestone UUID" },
        due_date: { type: "string", description: DATE },
        completion_pct: { type: "number", description: "0-100 integer" },
        source,
        external_ref: externalRef,
        external_url: externalUrl,
        expected_updated_at: expectedUpdatedAt,
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const { task_id, ...body } = args;
      return { path: `/api/tasks/${idSeg("task_id", task_id)}`, method: "PATCH", body };
    },
  },
  {
    name: "request_task_deletion",
    description:
      "Request deletion of a task. Does NOT delete immediately — creates a maker-checker " +
      "deletion request (status=pending) that must be approved by a different actor with " +
      "scope task:delete:approve. Self-approval is rejected by the server.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task UUID" },
        reason: { type: "string", description: "Reason for deletion (required — goes to the audit trail)" },
      },
      required: ["task_id", "reason"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/tasks/${idSeg("task_id", args.task_id)}`,
      method: "DELETE",
      body: { reason: args.reason },
    }),
  },
  {
    // Q-GOV-27 (2026-10-17): the maker can take their own request back. This is the ONLY deletion verb
    // the agent surfaces besides requesting: it never approves or rejects (those stay human, 403 for a token).
    name: "withdraw_deletion_request",
    description:
      "Withdraw a deletion request that YOU (or the person this token acts for) raised, while it is still " +
      "pending. Use it when the request was a mistake or is no longer wanted. It cancels the request " +
      "without deleting anything and is audited. It cannot approve or reject anything, and it only works " +
      "on your own pending request: a request someone else raised, or one already decided, is refused.",
    parameters: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "Deletion request UUID (returned when the deletion was requested)" },
      },
      required: ["request_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/deletion-requests/${idSeg("request_id", args.request_id)}/withdraw`,
      method: "POST",
    }),
  },

  // ── Risks ─────────────────────────────────────────────────────────────────
  {
    name: "list_risks",
    description: "List risks for a project.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" }, page, limit },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/projects/${idSeg("project_id", args.project_id)}/risks?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}`,
      method: "GET",
    }),
  },
  {
    name: "create_risk",
    description: "Create a risk under a project. Rated by severity x likelihood.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        title: { type: "string", description: "Risk title" },
        description: { type: "string" },
        severity: { type: "string", enum: RISK_LEVELS },
        likelihood: { type: "string", enum: RISK_LEVELS },
        status: { type: "string", enum: RISK_STATUSES },
        mitigation: { type: "string", description: "Mitigation plan" },
        resolution: { type: "string", description: "How the risk was closed (needed if created already closed), up to 4000 chars" },
        owner_id: { type: "string", description: "Profile UUID of owner" },
        due_date: { type: "string", description: DATETIME },
        source,
        external_ref: externalRef,
        external_url: externalUrl,
      },
      required: ["project_id", "title", "severity", "likelihood"],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const { project_id, ...body } = args;
      return { path: `/api/projects/${idSeg("project_id", project_id)}/risks`, method: "POST", body };
    },
  },
  {
    name: "update_risk",
    description:
      "Update a risk (status, severity, likelihood, mitigation, resolution). Audited. Closing a risk needs a resolution note: " +
      "a 422 asking for one means resend with resolution set.",
    parameters: {
      type: "object",
      properties: {
        risk_id: { type: "string", description: "Risk UUID" },
        title: { type: "string" },
        description: { type: "string" },
        severity: { type: "string", enum: RISK_LEVELS },
        likelihood: { type: "string", enum: RISK_LEVELS },
        status: { type: "string", enum: RISK_STATUSES },
        mitigation: { type: "string" },
        resolution: { type: "string", description: "How the risk was closed (required when status becomes closed), up to 4000 chars" },
        owner_id: { type: "string", description: "Profile UUID of owner" },
        source,
        external_ref: externalRef,
        external_url: externalUrl,
        expected_updated_at: expectedUpdatedAt,
      },
      required: ["risk_id"],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const { risk_id, ...body } = args;
      return { path: `/api/risks/${idSeg("risk_id", risk_id)}`, method: "PATCH", body };
    },
  },

  // ── Issues ────────────────────────────────────────────────────────────────
  {
    name: "list_issues",
    description: "List issues for a project.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" }, page, limit },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/projects/${idSeg("project_id", args.project_id)}/issues?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}`,
      method: "GET",
    }),
  },
  {
    name: "create_issue",
    description: "Create an issue under a project. Ranked by priority; severity is optional detail.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        title: { type: "string", description: "Issue title" },
        description: { type: "string" },
        priority: { type: "string", enum: ISSUE_PRIORITIES },
        severity: { type: "string", enum: ISSUE_SEVERITIES },
        status: { type: "string", enum: ISSUE_STATUSES },
        owner_id: { type: "string", description: "Profile UUID of owner" },
        resolution: { type: "string", description: "How the issue was/will be resolved" },
        source,
        external_ref: externalRef,
        external_url: externalUrl,
      },
      required: ["project_id", "title", "priority"],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const { project_id, ...body } = args;
      return { path: `/api/projects/${idSeg("project_id", project_id)}/issues`, method: "POST", body };
    },
  },
  {
    name: "update_issue",
    description:
      "Update an issue (status, priority, resolution). Audited. Resolving or closing an issue needs a resolution note: " +
      "a 422 asking for one means resend with resolution set.",
    parameters: {
      type: "object",
      properties: {
        issue_id: { type: "string", description: "Issue UUID" },
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: ISSUE_PRIORITIES },
        severity: { type: "string", enum: ISSUE_SEVERITIES },
        status: { type: "string", enum: ISSUE_STATUSES },
        owner_id: { type: "string", description: "Profile UUID of owner" },
        resolution: { type: "string" },
        source,
        external_ref: externalRef,
        external_url: externalUrl,
        expected_updated_at: expectedUpdatedAt,
      },
      required: ["issue_id"],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const { issue_id, ...body } = args;
      return { path: `/api/issues/${idSeg("issue_id", issue_id)}`, method: "PATCH", body };
    },
  },

  // ── Budget ────────────────────────────────────────────────────────────────
  {
    name: "get_budget",
    description: "Get the budget and actuals for a project (planned, committed, actual, variance, burn_pct).",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" } },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({ path: `/api/projects/${idSeg("project_id", args.project_id)}/budget`, method: "GET" }),
  },

  // ── Clashes ───────────────────────────────────────────────────────────────
  {
    name: "list_clashes",
    description: "List resource/schedule/dependency clashes across the workspace.",
    parameters: {
      type: "object",
      properties: { page, limit },
      required: [],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/clashes?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}`,
      method: "GET",
    }),
  },

  // ── Resources ─────────────────────────────────────────────────────────────
  {
    name: "list_resources",
    description: "List resource members (people with cost rates and capacity) in the workspace.",
    parameters: {
      type: "object",
      properties: { page, limit },
      required: [],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/resources?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}`,
      method: "GET",
    }),
  },

  // ── Search ────────────────────────────────────────────────────────────────
  {
    name: "search_workspace",
    description:
      "Full-workspace search across projects, tasks, risks, issues, clashes, documents, " +
      "change requests, and decisions. Returns typed results with navigation hrefs.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search text (case-insensitive)" } },
      required: ["query"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/search?q=${encodeURIComponent(String(args.query ?? ""))}`,
      method: "GET",
    }),
  },

  // ── Audit ─────────────────────────────────────────────────────────────────
  {
    name: "query_audit",
    description:
      "Query the immutable audit log. Filter by target_type, target_id, action, actor_id, or " +
      "channel. Every write in NoPM produces exactly one audit row. To tail the log, pass " +
      "since=<last seen created_at> and order=asc.",
    parameters: {
      type: "object",
      properties: {
        target_type: {
          type: "string",
          description: "project | task | risk | issue | milestone | clash | resource",
        },
        target_id: { type: "string", description: "UUID of the target entity" },
        action: { type: "string", description: "e.g. task.create | task.update" },
        actor_id: { type: "string", description: "UUID of the actor" },
        channel: { type: "string", enum: AUDIT_CHANNELS, description: "Declared client that wrote the row (R-82)" },
        since: { type: "string", format: "date-time", description: "ISO 8601 timestamp; only rows at or after this time (R-85)" },
        order: { type: "string", enum: ["asc", "desc"], description: "Sort direction by created_at, default desc (R-85)" },
        page,
        limit,
      },
      required: [],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const params = new URLSearchParams();
      if (args.target_type) params.set("target_type", String(args.target_type));
      if (args.target_id) params.set("target_id", String(args.target_id));
      if (args.action) params.set("action", String(args.action));
      if (args.actor_id) params.set("actor_id", String(args.actor_id));
      if (args.channel) params.set("channel", String(args.channel));
      if (args.since) params.set("since", String(args.since));
      if (args.order) params.set("order", String(args.order));
      params.set("page", String(args.page ?? 1));
      params.set("limit", String(args.limit ?? 20));
      return { path: `/api/audit?${params.toString()}`, method: "GET" };
    },
  },

  // ── Approvals (read-only) ─────────────────────────────────────────────────
  {
    name: "list_pending_approvals",
    description:
      "List the governed decisions waiting on a human in this workspace, oldest first: task and " +
      "project deletion requests, change requests (raised/under review), " +
      "and rebaselines awaiting sign-off. Each item has can_decide plus reason_if_not " +
      "(missing scope, or four-eyes: the requester cannot decide their own request). READ-ONLY — " +
      "there is deliberately no approve/decide tool: a person decides in the console. Use this " +
      "to answer \"what is waiting for me?\" and to tell the user what needs their decision. " +
      "`hidden_kinds` lists kinds this token's scopes cannot read, so an empty list is not " +
      "proof that nothing is pending.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: PENDING_APPROVAL_KINDS, description: "Only this kind (default: all readable kinds)" },
        page,
        limit: { type: "number", description: "Results per page (default 50, max 200)" },
      },
      required: [],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const params = new URLSearchParams();
      if (args.kind) params.set("kind", String(args.kind));
      if (args.page) params.set("page", String(args.page));
      if (args.limit) params.set("limit", String(args.limit));
      const qs = params.toString();
      return { path: qs ? `/api/review?${qs}` : "/api/review", method: "GET" };
    },
  },
];

// ── Guarded registry ──────────────────────────────────────────────────────

/**
 * Wrap a tool so every request it builds is checked against the shape of the
 * request it builds for `{}` (its own route): same method, same path segments
 * with ids in the same places, nothing percent-encoded or dotted in the path.
 */
export function guardTool(tool) {
  const probe = tool.toRequest({});
  const expectedShape = routeShape(probe.path);
  const expectedMethod = probe.method;
  return {
    ...tool,
    toRequest: (args) => {
      const req = tool.toRequest(args);
      const cut = req.path.indexOf("?");
      const pathname = cut === -1 ? req.path : req.path.slice(0, cut);
      if (
        req.method !== expectedMethod ||
        !PRINTABLE.test(req.path) ||
        req.path.includes("#") ||
        !SAFE_PATHNAME.test(pathname) ||
        routeShape(req.path) !== expectedShape
      ) {
        throw new ToolArgError(`${tool.name}: arguments do not resolve to this tool's own endpoint`);
      }
      return req;
    },
  };
}

/** @type {ToolRegistryEntry[]} */
export const TOOL_REGISTRY = RAW_TOOLS.map(guardTool);

// ── Governance tools for the MCP surfaces ONLY ──────────────────────────────
//
// NOT part of TOOL_REGISTRY, so the in-app assistant (which maps TOOL_REGISTRY
// one-to-one) never gets them. The assistant has no approve/decide tool and its
// ephemeral token holds none of these scopes (see TOOL_SCOPES in
// web/src/lib/assistant/tools.ts); an MCP client drives them with its OWN
// personal access token, so the API enforces the same rules as for any REST caller:
//   - sign_off_rebaseline / apply_rebaseline need scope rebaseline:approve (never
//     granted by a wildcard) AND a token whose creator is currently an admin or
//     manager (owner decision D-16) — otherwise the API's 403 comes back verbatim;
//   - four-eyes by person still applies (a token never decides what its creator raised).
// Locked to the OpenAPI spec and the Zod validators by
// web/src/lib/assistant/tools-mcp-governance.test.ts.

export const REBASELINE_VOTES = ["go", "no_go"];
export const CHANGE_CATEGORIES = ["scope", "schedule", "cost", "quality", "resource", "other"];
export const CHANGE_PRIORITIES = ["low", "medium", "high", "critical"];
export const DECISION_STATUSES = ["proposed", "accepted", "superseded", "rejected"];
export const DOCUMENT_TYPES = ["charter", "plan", "raid", "status_report", "change_request", "minutes", "spec", "other"];
export const DOCUMENT_STATUSES = ["draft", "in_review", "approved", "archived"];

/** @type {ToolRegistryEntry[]} */
const RAW_MCP_GOVERNANCE_TOOLS = [
  {
    name: "create_change_request",
    description:
      "Raise a change request on a project (scope: change:write). Status is raised or under_review only; " +
      "approval is a separate decision by an admin or manager, never made here. Needs a token with a recorded owner.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        title: { type: "string", description: "Short title, 1-255 chars" },
        description: { type: "string", description: "Up to 10,000 chars" },
        category: { type: "string", enum: CHANGE_CATEGORIES },
        priority: { type: "string", enum: CHANGE_PRIORITIES },
        status: { type: "string", enum: ["raised", "under_review"] },
        impact_summary: { type: "string", description: "Up to 10,000 chars" },
        impact_schedule_days: { type: "number", description: "Integer days of schedule impact (negative = earlier)" },
        impact_cost: { type: "number", description: "Cost impact in the project currency" },
        target_date: { type: "string", description: DATE },
      },
      required: ["project_id", "title"],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const { project_id, ...body } = args;
      return { path: `/api/projects/${idSeg("project_id", project_id)}/change-requests`, method: "POST", body };
    },
  },
  {
    name: "propose_rebaseline",
    description:
      "Propose a rebaseline of a project's baseline dates (pending sign-off when the project is locked) (scope: project:write). A project may have only one " +
      "rebaseline waiting for sign-off (409 pending_rebaseline_exists). It then needs sign-off by an admin or manager " +
      "other than the requester and an apply step.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        reason: { type: "string", description: "Why the baseline must move, 1-2000 chars" },
      },
      required: ["project_id", "reason"],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const { project_id, ...body } = args;
      return { path: `/api/projects/${idSeg("project_id", project_id)}/rebaselines`, method: "POST", body };
    },
  },
  {
    name: "sign_off_rebaseline",
    description:
      "Cast a go / no_go sign-off vote on a rebaseline awaiting sign-off (scope: rebaseline:approve, which a wildcard " +
      "never grants). Only works when this token's creator is currently an admin or manager and is a different person " +
      "from the requester; otherwise the API answers 403 (role_not_permitted: \"Only managers and admins can approve\", " +
      "or self_approval) and nothing changes. Do not retry a 403; tell the user who needs to decide.",
    parameters: {
      type: "object",
      properties: {
        rebaseline_id: { type: "string", description: "Rebaseline UUID" },
        vote: { type: "string", enum: REBASELINE_VOTES },
        comment: { type: "string", description: "Optional, up to 2000 chars" },
      },
      required: ["rebaseline_id", "vote"],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const { rebaseline_id, ...body } = args;
      return { path: `/api/rebaselines/${idSeg("rebaseline_id", rebaseline_id)}/signoff`, method: "POST", body };
    },
  },
  {
    name: "apply_rebaseline",
    description:
      "Apply an approved rebaseline: milestone, task and project baseline dates become the current plan (scope: " +
      "rebaseline:approve). Same rules as sign_off_rebaseline (token creator must be an admin or manager, different person from the " +
      "requester); 422 project_not_locked if the project was unlocked meanwhile. 403s come back verbatim.",
    parameters: {
      type: "object",
      properties: { rebaseline_id: { type: "string", description: "Rebaseline UUID" } },
      required: ["rebaseline_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/rebaselines/${idSeg("rebaseline_id", args.rebaseline_id)}/apply`,
      method: "POST",
    }),
  },
  {
    name: "create_decision",
    description: "Log a decision in a project's decision register (scope: decision:write). Gets a DEC-NNN reference.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        title: { type: "string", description: "1-255 chars" },
        context: { type: "string", description: "Up to 10,000 chars" },
        options: { type: "string", description: "Options considered, up to 10,000 chars" },
        decision: { type: "string", description: "What was decided, up to 10,000 chars" },
        rationale: { type: "string", description: "Why, up to 10,000 chars" },
        status: { type: "string", enum: DECISION_STATUSES },
        decided_at: { type: "string", description: DATETIME },
        supersedes: { type: "string", description: "UUID of the decision this replaces" },
      },
      required: ["project_id", "title"],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const { project_id, ...body } = args;
      return { path: `/api/projects/${idSeg("project_id", project_id)}/decisions`, method: "POST", body };
    },
  },
  {
    name: "create_document",
    description:
      "Create a document record (scope: document:write): a title, type, status, summary or body, optionally linked to a " +
      "project. Gets a DOC-NNN reference. File upload is a browser step, not part of this tool.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID (optional)" },
        folder: { type: "string", description: "Folder name, default General" },
        title: { type: "string", description: "1-500 chars" },
        doc_type: { type: "string", enum: DOCUMENT_TYPES },
        status: { type: "string", enum: DOCUMENT_STATUSES },
        summary: { type: "string", description: "Up to 10,000 chars" },
        body: { type: "string", description: "Up to 100,000 chars" },
        external_url: { type: "string", format: "uri", maxLength: 2000 },
        owner_id: { type: "string", description: "Owner member UUID" },
      },
      required: ["title", "doc_type"],
      additionalProperties: false,
    },
    toRequest: (args) => ({ path: "/api/documents", method: "POST", body: args }),
  },
  {
    name: "close_sprint",
    description:
      "Close an active sprint (scope: sprint:write). If attached tasks are unfinished the API answers 422 unfinished_tasks " +
      "and changes nothing: ask the person where they go, then resend with move_unfinished_to set to \"backlog\" or the " +
      "UUID of another planned/active sprint of the same project. Finished tasks stay with the closed sprint. Audited.",
    parameters: {
      type: "object",
      properties: {
        sprint_id: { type: "string", description: "Sprint UUID" },
        move_unfinished_to: {
          type: "string",
          description: "Where unfinished tasks go: \"backlog\" or a planned/active sprint UUID of the same project",
        },
      },
      required: ["sprint_id"],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const { sprint_id, ...body } = args;
      return { path: `/api/sprints/${idSeg("sprint_id", sprint_id)}/close`, method: "POST", body };
    },
  },
];

/**
 * Governance tools offered by the MCP servers (stdio server.mjs; the remote
 * /api/mcp route can register them too) on top of TOOL_REGISTRY. Never merged
 * into TOOL_REGISTRY: the in-app assistant must not get approve tools.
 * @type {ToolRegistryEntry[]}
 */
export const MCP_GOVERNANCE_TOOLS = RAW_MCP_GOVERNANCE_TOOLS.map(guardTool);

/** Everything an MCP client sees: the shared registry plus the governance tools. */
export const MCP_TOOLS = [...TOOL_REGISTRY, ...MCP_GOVERNANCE_TOOLS];

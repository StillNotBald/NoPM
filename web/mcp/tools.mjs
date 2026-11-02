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
export const RISK_CATEGORIES = [
  "technical",
  "schedule",
  "cost",
  "resourcing",
  "scope_requirements",
  "supplier_external",
  "regulatory_legal",
  "organisational",
];
export const RISK_IMPACT_AREAS = ["schedule", "cost", "scope", "quality", "reputation", "compliance"];
export const ISSUE_PRIORITIES = ["low", "medium", "high", "urgent"];
export const ISSUE_STATUSES = ["open", "in_progress", "resolved", "closed"];
export const ISSUE_SEVERITIES = ["low", "medium", "high", "critical"];
// Mirrors AuditChannel in web/src/lib/audit/channel.ts (R-82/R-85) — the
// six channel values audit_log's DB check constraint accepts ("lark" is
// server-derived for chat-card decisions; it can be filtered on, never declared).
export const AUDIT_CHANNELS = ["ui", "api", "cli", "mcp", "assistant", "lark"];
// Mirrors PENDING_KINDS in web/src/lib/review/pending.ts (the GET /api/review
// `kind` filter); the first four are the kinds the governed decision path
// accepts (every *_deletion kind and change_request). Locked by web/src/lib/review/tool.test.ts.
export const PENDING_APPROVAL_KINDS = [
  "task_deletion",
  "project_deletion",
  "risk_deletion",
  "issue_deletion",
  "expense_deletion",
  "document_deletion",
  "milestone_deletion",
  "program_deletion",
  "sprint_deletion",
  "resource_deletion",
  "allocation_deletion",
  "clash_deletion",
  "change_request",
  "rebaseline",
];

// "emergency" is a LEGACY filter value only: new emergency changes commit as approved and never sit in this status.
// It stays so a read of old rows still validates (it leaves after the CUTOVER/12 live check shows none).
export const CHANGE_REQUEST_STATUSES = ["raised", "under_review", "emergency", "approved", "rejected", "deferred", "implemented"];
export const DOCUMENT_TYPES = ["charter", "plan", "raid", "status_report", "change_request", "minutes", "spec", "other"];
export const DOCUMENT_STATUSES = ["draft", "in_review", "approved", "archived"];
export const EVIDENCE_TYPES = ["test_result", "uat_signoff", "deploy_record", "screenshot", "other"];
export const EVIDENCE_RESULTS = ["pass", "fail", "partial", "n/a"];
const DECISION_STATUSES_READ = ["proposed", "accepted", "superseded", "rejected"];

const DATE = "ISO date, YYYY-MM-DD";
const DATETIME = "ISO 8601 datetime with timezone, e.g. 2026-09-30T00:00:00Z";

const page = { type: "number", description: "Page number (default 1)" };
// Lean list payloads (A7/K5, R-129). Lists default to a SUMMARY column set.
// Mirrors the allow-lists in web/src/lib/api/views.ts (locked by views tests).
const view = {
  type: "string",
  enum: ["summary", "full"],
  description: "summary (default, lean) or full (every column)",
};
const fields = {
  type: "string",
  description: "Comma-separated columns, e.g. id,name. Overrides view.",
};

/** Query-string suffix for view / fields. Never throws; values are encoded so they cannot add a parameter. */
function qview(args) {
  let out = "";
  if (args.view !== undefined && args.view !== null) out += `&view=${encodeURIComponent(String(args.view))}`;
  if (args.fields !== undefined && args.fields !== null) out += `&fields=${encodeURIComponent(String(args.fields))}`;
  return out;
}
const limit = { type: "number", description: "Results per page (default 20, max 100)" };

// ── Complement seam (0041, R-81) — mirrors the create/update Zod validators
// exactly (source pattern, external_ref maxLength 200, external_url uri). NoPM
// does not replace Jira/Slack/Teams; it is the governed record beside them.
const source = {
  type: "string",
  pattern: "^[a-z0-9][a-z0-9_-]{0,39}$",
  description: "System this mirrors, e.g. jira",
};
const externalRef = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  description: "Id/key in that system",
};
const externalUrl = {
  type: "string",
  format: "uri",
  maxLength: 2000,
  description: "Link to it there",
};

// ── Blocker reason and ETA (R-166, R-174) — mirror the task validators (blocker_reason max 500, eta a real YYYY-MM-DD date).
// Both are nullable on the API: send null to clear.
const BLOCKER_REASON = {
  type: ["string", "null"],
  maxLength: 500,
  description: "Why it is blocked (max 500 chars); null clears",
};
const ETA = {
  type: ["string", "null"],
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
  description: "Forecast finish, YYYY-MM-DD; null clears",
};

// ── Optimistic concurrency (R-90) — mirrors the update Zod validators exactly
// (ISO 8601 datetime with offset). Opt-in: omit it for today's last-write-wins
// behavior; send the updated_at you last read to get a 412 instead of
// silently overwriting a concurrent edit.
const expectedUpdatedAt = {
  type: "string",
  format: "date-time",
  description: "updated_at you last read; a 412 is returned if the record changed since",
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
    description: "List projects (id, code, name, RAG, dates). Use first to turn a project name into its id. Lean summary by default; get_project for one in full.",
    parameters: {
      type: "object",
      properties: { page, limit, view, fields },
      required: [],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/projects?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}${qview(args)}`,
      method: "GET",
    }),
  },
  {
    name: "get_project",
    description: "Get one project in full: charter fields, RAG status, dates, owner. Needs project_id from list_projects.",
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
    description: "Create a project. `code` is its short unique identifier. Returns the new project with its id.",
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
    description: "Update a project (name, RAG status, completion, dates, owner). Needs project_id. Audited.",
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
    description: "Request deletion of a project. Does not delete: it raises a request that a DIFFERENT person must approve (four-eyes) and stays pending until then. Refused while the project is locked or has open work the rules protect.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        reason: { type: "string", description: "Why (required; audit trail)" },
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
    description: "List a project's milestones (name, status, target date). Needs project_id. Lean summary by default.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" }, page, limit, view, fields },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/projects/${idSeg("project_id", args.project_id)}/milestones?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}${qview(args)}`,
      method: "GET",
    }),
  },
  {
    name: "create_milestone",
    description: "Create a milestone in a project. Needs project_id and name; target date and status are optional. Returns the milestone with its id.",
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
    description: "Update a milestone (status, target date, completion). Completing one with open tasks returns 422 open_tasks: if the person confirms, resend with confirm_open_tasks: true.",
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
    description: "List one project's tasks. Needs project_id. For my work, overdue or due-soon across projects use list_workspace_tasks.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" }, page, limit, view, fields },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/projects/${idSeg("project_id", args.project_id)}/tasks?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}${qview(args)}`,
      method: "GET",
    }),
  },
  {
    name: "list_workspace_tasks",
    description: "List tasks across all projects. Use for my work, overdue or due-soon: assignee_id=\"me\", overdue=true, or a due_before/due_after window. Needs no ids. Returns a page with total.",
    parameters: {
      type: "object",
      properties: {
        assignee_id: { type: "string", description: "\"me\" for the caller's tasks, or a resource member UUID (from list_resources)" },
        project_id: { type: "string", description: "Project UUID, to narrow to one project" },
        status_type: { type: "string", enum: TASK_STATUS_TYPES },
        priority: { type: "string", enum: TASK_PRIORITIES },
        overdue: { type: "boolean", description: "true: past due and not completed or canceled" },
        due_before: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", description: DATE },
        due_after: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", description: DATE },
        q: { type: "string", description: "Name contains this text" },
        sort: { type: "string", enum: ["due_date:asc", "due_date:desc", "priority:desc", "created_at:desc", "name:asc"] },
        page,
        limit,
        view,
        fields,
      },
      required: [],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const params = new URLSearchParams();
      if (args.assignee_id !== undefined && args.assignee_id !== null) {
        if (args.assignee_id !== "me" && !UUID_RE.test(String(args.assignee_id))) {
          throw new ToolArgError("assignee_id must be \"me\" or a UUID");
        }
        params.set("assignee_id", String(args.assignee_id));
      }
      if (args.project_id) params.set("project_id", idSeg("project_id", args.project_id));
      for (const k of ["status_type", "priority", "due_before", "due_after", "q", "sort", "view", "fields"]) {
        if (args[k] !== undefined && args[k] !== null && args[k] !== "") params.set(k, String(args[k]));
      }
      if (args.overdue === true) params.set("overdue", "true");
      params.set("page", String(Number(args.page) || 1));
      params.set("limit", String(Number(args.limit) || 20));
      return { path: `/api/tasks?${params.toString()}`, method: "GET" };
    },
  },
  {
    name: "get_task",
    description: "Get one task in full: status, assignee, estimates, checklist. Needs task_id from list_tasks.",
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
    description: "Create a task in a project. Needs project_id and name; status_type defaults to backlog, priority to medium. Returns the task with its id.",
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
        blocker_reason: BLOCKER_REASON,
        eta: ETA,
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
    description: "Update a task. Changing status_type is the governed Kanban move and writes an audit row. Needs task_id.",
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
        blocker_reason: BLOCKER_REASON,
        eta: ETA,
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
    description: "Request deletion of a task. Does not delete: it raises a request that a DIFFERENT person must approve (four-eyes) and stays pending until then. Needs task_id.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task UUID" },
        reason: { type: "string", description: "Why (required; audit trail)" },
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
    name: "request_risk_deletion",
    description: "Request deletion of a risk. Does not delete: it raises a request that a DIFFERENT person must approve (four-eyes) and stays pending until then. Needs risk_id from list_risks.",
    parameters: {
      type: "object",
      properties: {
        risk_id: { type: "string", description: "Risk UUID" },
        reason: { type: "string", description: "Reason for deletion (required, goes to the audit trail)" },
        assigned_approver_id: { type: "string", description: "Admin/manager profile UUID to route to (optional)" },
      },
      required: ["risk_id", "reason"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/risks/${idSeg("risk_id", args.risk_id)}`,
      method: "DELETE",
      body: { reason: args.reason, ...(args.assigned_approver_id ? { assigned_approver_id: args.assigned_approver_id } : {}) },
    }),
  },
  {
    name: "request_issue_deletion",
    description: "Request deletion of an issue. Does not delete: it raises a request that a DIFFERENT person must approve (four-eyes) and stays pending until then. Needs issue_id from list_issues.",
    parameters: {
      type: "object",
      properties: {
        issue_id: { type: "string", description: "Issue UUID" },
        reason: { type: "string", description: "Reason for deletion (required, goes to the audit trail)" },
        assigned_approver_id: { type: "string", description: "Admin/manager profile UUID to route to (optional)" },
      },
      required: ["issue_id", "reason"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/issues/${idSeg("issue_id", args.issue_id)}`,
      method: "DELETE",
      body: { reason: args.reason, ...(args.assigned_approver_id ? { assigned_approver_id: args.assigned_approver_id } : {}) },
    }),
  },
  {
    name: "request_expense_deletion",
    description: "Request deletion of an expense (a money record). Does not delete: it raises a request that a DIFFERENT person must approve (four-eyes) and stays pending until then. Needs expense_id from list_expenses.",
    parameters: {
      type: "object",
      properties: {
        expense_id: { type: "string", description: "Expense UUID" },
        reason: { type: "string", description: "Reason for deletion (required, goes to the audit trail)" },
        assigned_approver_id: { type: "string", description: "Admin/manager profile UUID to route to (optional)" },
      },
      required: ["expense_id", "reason"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/expenses/${idSeg("expense_id", args.expense_id)}`,
      method: "DELETE",
      body: { reason: args.reason, ...(args.assigned_approver_id ? { assigned_approver_id: args.assigned_approver_id } : {}) },
    }),
  },
  {
    name: "request_document_deletion",
    description: "Request deletion of a document. Does not delete: it raises a request that a DIFFERENT person must approve (four-eyes) and stays pending until then. Needs document_id from list_documents. The stored file is removed on approval.",
    parameters: {
      type: "object",
      properties: {
        document_id: { type: "string", description: "Document UUID" },
        reason: { type: "string", description: "Reason for deletion (required, goes to the audit trail)" },
        assigned_approver_id: { type: "string", description: "Admin/manager profile UUID to route to (optional)" },
      },
      required: ["document_id", "reason"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/documents/${idSeg("document_id", args.document_id)}`,
      method: "DELETE",
      body: { reason: args.reason, ...(args.assigned_approver_id ? { assigned_approver_id: args.assigned_approver_id } : {}) },
    }),
  },
  {
    name: "request_milestone_deletion",
    description: "Request deletion of a milestone. Does not delete: it raises a request that a DIFFERENT person must approve (four-eyes) and stays pending until then. Needs milestone_id from list_milestones. Refused while the project is locked; its tasks are kept.",
    parameters: {
      type: "object",
      properties: {
        milestone_id: { type: "string", description: "Milestone UUID" },
        reason: { type: "string", description: "Reason for deletion (required, goes to the audit trail)" },
        assigned_approver_id: { type: "string", description: "Admin/manager profile UUID to route to (optional)" },
      },
      required: ["milestone_id", "reason"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/milestones/${idSeg("milestone_id", args.milestone_id)}`,
      method: "DELETE",
      body: { reason: args.reason, ...(args.assigned_approver_id ? { assigned_approver_id: args.assigned_approver_id } : {}) },
    }),
  },
  {
    name: "request_program_deletion",
    description: "Request deletion of a program. Does not delete: it raises a request that a DIFFERENT person must approve (four-eyes) and stays pending until then. Needs program_id from list_programs. Its projects are kept and lose the grouping.",
    parameters: {
      type: "object",
      properties: {
        program_id: { type: "string", description: "Program UUID" },
        reason: { type: "string", description: "Reason for deletion (required, goes to the audit trail)" },
        assigned_approver_id: { type: "string", description: "Admin/manager profile UUID to route to (optional)" },
      },
      required: ["program_id", "reason"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/programs/${idSeg("program_id", args.program_id)}`,
      method: "DELETE",
      body: { reason: args.reason, ...(args.assigned_approver_id ? { assigned_approver_id: args.assigned_approver_id } : {}) },
    }),
  },
  {
    name: "request_sprint_deletion",
    description: "Request deletion of a sprint. Does not delete: it raises a request that a DIFFERENT person must approve (four-eyes) and stays pending until then. Needs sprint_id from list_sprints. Only a planned sprint with no tasks qualifies (422 otherwise).",
    parameters: {
      type: "object",
      properties: {
        sprint_id: { type: "string", description: "Sprint UUID" },
        reason: { type: "string", description: "Reason for deletion (required, goes to the audit trail)" },
        assigned_approver_id: { type: "string", description: "Admin/manager profile UUID to route to (optional)" },
      },
      required: ["sprint_id", "reason"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/sprints/${idSeg("sprint_id", args.sprint_id)}`,
      method: "DELETE",
      body: { reason: args.reason, ...(args.assigned_approver_id ? { assigned_approver_id: args.assigned_approver_id } : {}) },
    }),
  },
  {
    name: "request_resource_deletion",
    description: "Request deletion of a resource member. Does not delete: it raises a request that a DIFFERENT person must approve (four-eyes) and stays pending until then. Needs resource_id from list_resources. Approving also deletes the member's allocations.",
    parameters: {
      type: "object",
      properties: {
        resource_id: { type: "string", description: "Resource member UUID" },
        reason: { type: "string", description: "Reason for deletion (required, goes to the audit trail)" },
        assigned_approver_id: { type: "string", description: "Admin/manager profile UUID to route to (optional)" },
      },
      required: ["resource_id", "reason"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/resources/${idSeg("resource_id", args.resource_id)}`,
      method: "DELETE",
      body: { reason: args.reason, ...(args.assigned_approver_id ? { assigned_approver_id: args.assigned_approver_id } : {}) },
    }),
  },
  {
    name: "request_allocation_deletion",
    description: "Request deletion of an allocation. Does not delete: it raises a request that a DIFFERENT person must approve (four-eyes) and stays pending until then. Needs allocation_id from list_allocations.",
    parameters: {
      type: "object",
      properties: {
        allocation_id: { type: "string", description: "Allocation UUID" },
        reason: { type: "string", description: "Reason for deletion (required, goes to the audit trail)" },
        assigned_approver_id: { type: "string", description: "Admin/manager profile UUID to route to (optional)" },
      },
      required: ["allocation_id", "reason"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/allocations/${idSeg("allocation_id", args.allocation_id)}`,
      method: "DELETE",
      body: { reason: args.reason, ...(args.assigned_approver_id ? { assigned_approver_id: args.assigned_approver_id } : {}) },
    }),
  },
  {
    name: "request_clash_deletion",
    description: "Request deletion of a clash. Does not delete: it raises a request that a DIFFERENT person must approve (four-eyes) and stays pending until then. Needs clash_id from list_clashes. To resolve a clash, update its status instead.",
    parameters: {
      type: "object",
      properties: {
        clash_id: { type: "string", description: "Clash UUID" },
        reason: { type: "string", description: "Reason for deletion (required, goes to the audit trail)" },
        assigned_approver_id: { type: "string", description: "Admin/manager profile UUID to route to (optional)" },
      },
      required: ["clash_id", "reason"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/clashes/${idSeg("clash_id", args.clash_id)}`,
      method: "DELETE",
      body: { reason: args.reason, ...(args.assigned_approver_id ? { assigned_approver_id: args.assigned_approver_id } : {}) },
    }),
  },
  {
    // Q-GOV-27 (2026-10-17): the maker can take their own request back. This is the ONLY deletion verb
    // the agent surfaces besides requesting: it never approves or rejects (those stay human, 403 for a token).
    name: "withdraw_deletion_request",
    description: "Withdraw a deletion request you raised (any kind) while it is still pending, for example when it was a mistake. Deletes nothing and cannot approve or reject. Needs request_id from list_pending_approvals; someone else's request is refused.",
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
    description: "List a project's risks (title, severity, status). Needs project_id. Lean summary by default.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" }, page, limit, view, fields },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/projects/${idSeg("project_id", args.project_id)}/risks?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}${qview(args)}`,
      method: "GET",
    }),
  },
  {
    name: "create_risk",
    description: "Create a risk in a project, rated by severity x likelihood. Needs project_id, title, severity and likelihood. Returns the risk with its id.",
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
        risk_category: { type: "string", enum: RISK_CATEGORIES, description: "PMBOK-style risk category" },
        impact_areas: {
          type: "array",
          items: { type: "string", enum: RISK_IMPACT_AREAS },
          maxItems: 6,
          description: "Every area this risk touches, e.g. [\"schedule\",\"cost\"]",
        },
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
    description: "Update a risk (status, severity, likelihood, mitigation, resolution). Closing needs a resolution note: on a 422 asking for one, resend with resolution set.",
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
        risk_category: { type: "string", enum: RISK_CATEGORIES, description: "PMBOK-style risk category" },
        impact_areas: {
          type: "array",
          items: { type: "string", enum: RISK_IMPACT_AREAS },
          maxItems: 6,
          description: "Every area this risk touches (replaces the stored list)",
        },
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
    description: "List a project's issues (title, priority, status). Needs project_id. Lean summary by default.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" }, page, limit, view, fields },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/projects/${idSeg("project_id", args.project_id)}/issues?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}${qview(args)}`,
      method: "GET",
    }),
  },
  {
    name: "create_issue",
    description: "Create an issue in a project, ranked by priority. Needs project_id, title and priority. Returns the issue with its id.",
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
    description: "Update an issue (status, priority, resolution). Resolving or closing needs a resolution note: on a 422 asking for one, resend with resolution set.",
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
    description: "Get a project's budget position: planned, committed, actual, variance, burn_pct. Needs project_id.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" } },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({ path: `/api/projects/${idSeg("project_id", args.project_id)}/budget`, method: "GET" }),
  },

  {
    name: "get_evm",
    description: "Get a project's earned-value numbers as the Budget page shows them: BAC, AC, EV, PV, CV, SV, CPI, SPI, EAC, ETC, VAC and committed. An index is null when undefined. Needs project_id.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" } },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({ path: `/api/projects/${idSeg("project_id", args.project_id)}/evm`, method: "GET" }),
  },

  {
    name: "get_project_trend",
    description: "Get a project's daily snapshot trend and the RAG it suggests, with the reason. Advice only; it never changes the declared RAG. Optional n days (default 28, max 120). Needs project_id.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        n: { type: "number", description: "Snapshots to use (default 28, max 120)" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/projects/${idSeg("project_id", args.project_id)}/trend${args.n ? `?n=${encodeURIComponent(String(args.n))}` : ""}`,
      method: "GET",
    }),
  },

  {
    name: "get_handover_report",
    description: "Key-person report: open items whose single owner has no backup, grouped by project and owner, plus items nobody owns and a bus-factor matrix per person. READ-ONLY. Optional project_id narrows it.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Only this project (UUID); omit for the whole workspace" } },
      required: [],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path:
        "/api/reports/handover" +
        (args.project_id !== undefined && args.project_id !== null ? `?project_id=${idSeg("project_id", args.project_id)}` : ""),
      method: "GET",
    }),
  },

  // ── Decision prep (read-only): change requests, decisions, documents ──────
  {
    name: "list_change_requests",
    description: "List change requests, newest first, optionally for one project or status. Lean summary by default; get_change_request for one in full. A person decides them in the console.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Only this project (UUID)" },
        status: { type: "string", enum: CHANGE_REQUEST_STATUSES, description: "Only this status" },
        page,
        limit,
        view,
        fields,
      },
      required: [],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path:
        `/api/change-requests?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}` +
        (args.project_id !== undefined && args.project_id !== null ? `&project_id=${idSeg("project_id", args.project_id)}` : "") +
        (args.status !== undefined && args.status !== null ? `&status=${encodeURIComponent(String(args.status))}` : "") +
        qview(args),
      method: "GET",
    }),
  },
  {
    name: "get_change_request",
    description: "Get one change request in full: description, impact and the decision (who, when, rationale). Evidence comes from the evidence route: list_documents with change_request_id. Needs change_request_id.",
    parameters: {
      type: "object",
      properties: { change_request_id: { type: "string", description: "Change request UUID" } },
      required: ["change_request_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/change-requests/${idSeg("change_request_id", args.change_request_id)}`,
      method: "GET",
    }),
  },
  {
    name: "list_decisions",
    description: "List logged decisions, newest first, optionally for one project or status. Lean summary by default (title, status, who, when).",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Only this project (UUID)" },
        status: { type: "string", enum: DECISION_STATUSES_READ, description: "Only this status" },
        page,
        limit,
        view,
        fields,
      },
      required: [],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path:
        `/api/decisions?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}` +
        (args.project_id !== undefined && args.project_id !== null ? `&project_id=${idSeg("project_id", args.project_id)}` : "") +
        (args.status !== undefined && args.status !== null ? `&status=${encodeURIComponent(String(args.status))}` : "") +
        qview(args),
      method: "GET",
    }),
  },
  {
    name: "get_document",
    description: "Get one document: type, status, version, owner, external_url, summary and any stored text body. Files are not returned. Needs document_id from list_documents.",
    parameters: {
      type: "object",
      properties: { document_id: { type: "string", description: "Document UUID" } },
      required: ["document_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({ path: `/api/documents/${idSeg("document_id", args.document_id)}`, method: "GET" }),
  },
  {
    name: "list_documents",
    description: "List documents, newest first, optionally by project, folder, status or type. change_request_id lists the evidence attached to that request. The default view is lean (summary); view=full for more.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Only this project (UUID)" },
        folder: { type: "string", description: "Only this folder" },
        status: { type: "string", enum: DOCUMENT_STATUSES, description: "Only this status" },
        doc_type: { type: "string", enum: DOCUMENT_TYPES, description: "Only this document type" },
        change_request_id: { type: "string", description: "Only documents attached to this change request (UUID)" },
        page,
        limit,
        view,
        fields,
      },
      required: [],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path:
        `/api/documents?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}` +
        (args.project_id !== undefined && args.project_id !== null ? `&project_id=${idSeg("project_id", args.project_id)}` : "") +
        (args.folder !== undefined && args.folder !== null ? `&folder=${encodeURIComponent(String(args.folder))}` : "") +
        (args.status !== undefined && args.status !== null ? `&status=${encodeURIComponent(String(args.status))}` : "") +
        (args.doc_type !== undefined && args.doc_type !== null ? `&doc_type=${encodeURIComponent(String(args.doc_type))}` : "") +
        (args.change_request_id !== undefined && args.change_request_id !== null
          ? `&change_request_id=${idSeg("change_request_id", args.change_request_id)}`
          : "") +
        qview(args),
      method: "GET",
    }),
  },
  {
    name: "list_rebaselines",
    description: "List a project's rebaselines, newest version first: status, reason, requester, applied_at, before and after dates. Same data as get_baseline_history; use this one for status and reason. Needs project_id.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" }, page, limit },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/projects/${idSeg("project_id", args.project_id)}/rebaselines?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}`,
      method: "GET",
    }),
  },
  {
    name: "get_baseline_history",
    description: "Show how a project's baseline dates moved over time: applied rebaselines, newest first, with the before and after dates of each. Needs project_id.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" } },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/projects/${idSeg("project_id", args.project_id)}/rebaselines?page=1&limit=100`,
      method: "GET",
    }),
  },
  {
    name: "list_project_dependencies",
    description: "List a project's dependencies in both directions (depends_on, depended_on_by) with kind, note and the other project's id, code, name and RAG. Use to see what a decision or rebaseline knocks on to. Needs project_id.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" } },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/projects/${idSeg("project_id", args.project_id)}/dependencies`,
      method: "GET",
    }),
  },

  // ── Clashes ───────────────────────────────────────────────────────────────
  {
    name: "list_clashes",
    description: "List schedule, resource and dependency clashes across the workspace (type, status, projects involved). Use to find a clash id.",
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
    description: "List resource members (people with cost rate and capacity). Use to find a member id for assignment or request_resource_deletion; profile_id links a member to a login.",
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

  // ── Read-only id finders and inbox (R-187) ────────────────────────────────
  {
    name: "list_allocations",
    description: "List resource allocations (member, project, percent, window). Use to find an allocation id for request_allocation_deletion.",
    parameters: { type: "object", properties: { page, limit }, required: [], additionalProperties: false },
    toRequest: (args) => ({
      path: `/api/allocations?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}`,
      method: "GET",
    }),
  },
  {
    name: "list_programs",
    description: "List programs (groups of projects). Use to find a program id for request_program_deletion.",
    parameters: { type: "object", properties: { page, limit }, required: [], additionalProperties: false },
    toRequest: (args) => ({
      path: `/api/programs?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}`,
      method: "GET",
    }),
  },
  {
    name: "list_sprints",
    description: "List sprints, newest first. Use to find a sprint id for close_sprint or request_sprint_deletion.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID, to narrow to one project" },
        state: { type: "string", enum: ["planned", "active", "closed"] },
        page,
        limit,
      },
      required: [],
      additionalProperties: false,
    },
    toRequest: (args) => {
      let path = `/api/sprints?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}`;
      if (args.project_id) path += `&project_id=${idSeg("project_id", args.project_id)}`;
      if (args.state) path += `&state=${encodeURIComponent(String(args.state))}`;
      return { path, method: "GET" };
    },
  },
  {
    name: "list_expenses",
    description: "List a project's expenses (the actuals behind its budget), newest first. Use for what was spent or to find an expense id. Needs project_id.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID (from list_projects)" }, page, limit },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/projects/${idSeg("project_id", args.project_id)}/expenses?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}`,
      method: "GET",
    }),
  },
  {
    name: "list_notifications",
    description: "List the notifications of the person you act for, newest first. unread_only=true for what is new.",
    parameters: {
      type: "object",
      properties: { unread_only: { type: "boolean", description: "true: only unread" }, page, limit },
      required: [],
      additionalProperties: false,
    },
    toRequest: (args) => ({
      path: `/api/notifications?page=${qnum(args.page, 1)}&limit=${qnum(args.limit, 20)}${args.unread_only === true ? "&unread=1" : ""}`,
      method: "GET",
    }),
  },

  // ── Search ────────────────────────────────────────────────────────────────
  {
    name: "search_workspace",
    description: "Search projects, tasks, risks, issues, clashes, documents, change requests and decisions by text. Returns typed hits with ids and hrefs. Use to resolve a name to an id.",
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
    description: "Query the immutable audit log by target_type, target_id, action, actor_id or channel. To tail it, pass since=<last seen created_at> and order=asc.",
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
    description: "List governed decisions waiting on a person, oldest first: deletion requests, change requests and rebaselines awaiting sign-off. Each item has can_decide and reason_if_not, tier, deadline and what approval removes. READ-ONLY: there is no approve tool. hidden_kinds lists kinds this token cannot read, so an empty list is not proof nothing is pending. mine=true shows only requests assigned to the person behind this token.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: PENDING_APPROVAL_KINDS, description: "Only this kind (default: all readable kinds)" },
        mine: { type: "boolean", description: "Only requests assigned to the person behind this token (default false: the whole queue)" },
        page,
        limit: { type: "number", description: "Results per page (default 50, max 200)" },
      },
      required: [],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const params = new URLSearchParams();
      if (args.kind) params.set("kind", String(args.kind));
      if (args.mine === true) params.set("mine", "1");
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

/** @type {ToolRegistryEntry[]} */
const RAW_MCP_GOVERNANCE_TOOLS = [
  {
    name: "create_change_request",
    description: "Raise a change request on a project (status raised or under_review). Approval is a separate decision by an admin or manager. An is_emergency change commits as soon as it is raised and needs a token holding change:decide whose owner is a manager or admin.",
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
        tier: {
          type: "string",
          enum: ["routine", "normal", "high_risk", "strategic"],
          description:
            "Approval tier; omit for normal. The server may raise it, never lowers it. strategic needs an admin.",
        },
        is_emergency: {
          type: "boolean",
          description:
            "Commits at once, no approval. Manager or admin only; a token also needs change:decide.",
        },
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
    description: "Propose a rebaseline of a project's baseline dates. Only one may await sign-off at a time (409 pending_rebaseline_exists). It then needs sign-off by an admin or manager other than the requester, and an apply step.",
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
    description: "Cast a go / no_go sign-off vote on a rebaseline awaiting sign-off. Needs rebaseline:approve and a token owner who is an admin or manager and not the requester; otherwise 403 and nothing changes. Do not retry a 403: tell the user who must decide.",
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
    description: "Apply an approved rebaseline so its dates become the current plan. The token owner must be an admin or manager, not the requester; 422 project_not_locked if the project was unlocked meanwhile.",
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
    name: "attach_evidence",
    description: "Attach test, UAT or deploy evidence to a change request (scope: document:write). Needs no approve or decide scope. Send document_id to link an existing document, or title to create one. evidence_type is required. Allowed while the request is raised, under review, emergency, approved or implemented. Read it back with list_documents (change_request_id).",
    parameters: {
      type: "object",
      properties: {
        change_request_id: { type: "string", description: "Change request UUID" },
        document_id: { type: "string", description: "Existing document UUID to link (leave out when sending title)" },
        title: { type: "string", description: "New document title, 1-500 chars (leave out when sending document_id)" },
        doc_type: { type: "string", enum: DOCUMENT_TYPES, description: "New document only; default other" },
        folder: { type: "string", description: "New document only; default General" },
        summary: { type: "string", description: "New document only, up to 10,000 chars" },
        body: { type: "string", description: "New document only, up to 100,000 chars" },
        external_url: { type: "string", format: "uri", maxLength: 2000, description: "New document only: link to the test report, build or screenshot" },
        evidence_type: { type: "string", enum: EVIDENCE_TYPES },
        evidence_result: { type: "string", enum: EVIDENCE_RESULTS },
        tested_by: { type: "string", description: "Who ran the test (max 200 chars). From a token it is kept as an unverified note." },
        tested_at: { type: "string", description: DATETIME + " (default: now)" },
        evidence_note: { type: "string", description: "Up to 5,000 chars" },
      },
      required: ["change_request_id", "evidence_type"],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const { change_request_id, ...body } = args;
      return { path: `/api/change-requests/${idSeg("change_request_id", change_request_id)}/evidence`, method: "POST", body };
    },
  },
  {
    name: "implement_change_request",
    description: "Mark an approved change request as implemented (scope: change:write, not change:decide). The database refuses an implemented_at earlier than decided_at. Allowed for its requester or any admin or manager; the token needs a recorded owner. Once only: a repeat is 422 already_implemented, a non-approved request 422 invalid_transition. Decides nothing.",
    parameters: {
      type: "object",
      properties: {
        change_request_id: { type: "string", description: "Change request UUID" },
        note: { type: "string", maxLength: 2000, description: "Optional implementation note, up to 2,000 chars" },
      },
      required: ["change_request_id"],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const { change_request_id, ...body } = args;
      return { path: `/api/change-requests/${idSeg("change_request_id", change_request_id)}/implement`, method: "POST", body };
    },
  },
  {
    name: "create_decision",
    description: "Log a decision in a project's register (gets a DEC-NNN reference). change_request_id records which change it was for. A manager's or admin's decision defaults to accepted, anyone else's to proposed.",
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
        change_request_id: {
          type: "string",
          description: "UUID of the change request this decision was taken for (same workspace and same project as the decision)",
        },
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
    description: "Create a document record: title, type, status, summary or body, optionally linked to a project (gets a DOC-NNN reference). Pass change_request_id with evidence_type to file it as evidence. No file upload.",
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
        change_request_id: { type: "string", description: "Change request this document is evidence for (UUID; same project as the document)" },
        evidence_type: { type: "string", enum: EVIDENCE_TYPES, description: "Needs change_request_id" },
        evidence_result: { type: "string", enum: EVIDENCE_RESULTS, description: "Needs evidence_type" },
        tested_by_label: { type: "string", description: "Who ran the test, up to 200 chars (default: the token's name)" },
        tested_at: { type: "string", description: DATETIME + " (default: now)" },
        evidence_note: { type: "string", description: "Up to 5,000 chars" },
      },
      required: ["title", "doc_type"],
      additionalProperties: false,
    },
    toRequest: (args) => ({ path: "/api/documents", method: "POST", body: args }),
  },
  {
    name: "close_sprint",
    description: "Close an active sprint. If tasks are unfinished the API answers 422 unfinished_tasks and changes nothing: ask the person where they go, then resend with move_unfinished_to = \"backlog\" or another sprint's UUID. Needs sprint_id from list_sprints.",
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

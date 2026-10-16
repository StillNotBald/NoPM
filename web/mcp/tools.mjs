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
// five channel values audit_log's DB check constraint accepts.
export const AUDIT_CHANNELS = ["ui", "api", "cli", "mcp", "assistant"];
// Mirrors PENDING_KINDS in web/src/lib/review/pending.ts (the GET /api/review
// `kind` filter); the first four are the kinds the governed decision path
// accepts. Locked by web/src/lib/review/tool.test.ts.
export const PENDING_APPROVAL_KINDS = [
  "task_deletion",
  "project_deletion",
  "change_request",
  "timesheet",
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
export const TOOL_REGISTRY = [
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
      path: `/api/projects?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
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
    toRequest: (args) => ({ path: `/api/projects/${args.project_id}`, method: "GET" }),
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
      return { path: `/api/projects/${project_id}`, method: "PATCH", body };
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
      path: `/api/projects/${args.project_id}`,
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
      path: `/api/projects/${args.project_id}/milestones?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
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
      return { path: `/api/projects/${project_id}/milestones`, method: "POST", body };
    },
  },
  {
    name: "update_milestone",
    description: "Update a milestone (status, target date, completion). Audited.",
    parameters: {
      type: "object",
      properties: {
        milestone_id: { type: "string", description: "Milestone UUID" },
        name: { type: "string" },
        description: { type: "string" },
        target_date: { type: "string", description: DATETIME },
        status: { type: "string", enum: MILESTONE_STATUSES },
        completion_pct: { type: "number", description: "0-100 integer" },
        expected_updated_at: expectedUpdatedAt,
      },
      required: ["milestone_id"],
      additionalProperties: false,
    },
    toRequest: (args) => {
      const { milestone_id, ...body } = args;
      return { path: `/api/milestones/${milestone_id}`, method: "PATCH", body };
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
      path: `/api/projects/${args.project_id}/tasks?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
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
    toRequest: (args) => ({ path: `/api/tasks/${args.task_id}`, method: "GET" }),
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
      return { path: `/api/projects/${project_id}/tasks`, method: "POST", body };
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
      return { path: `/api/tasks/${task_id}`, method: "PATCH", body };
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
      path: `/api/tasks/${args.task_id}`,
      method: "DELETE",
      body: { reason: args.reason },
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
      path: `/api/projects/${args.project_id}/risks?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
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
      return { path: `/api/projects/${project_id}/risks`, method: "POST", body };
    },
  },
  {
    name: "update_risk",
    description: "Update a risk (status, severity, likelihood, mitigation). Audited.",
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
      return { path: `/api/risks/${risk_id}`, method: "PATCH", body };
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
      path: `/api/projects/${args.project_id}/issues?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
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
      return { path: `/api/projects/${project_id}/issues`, method: "POST", body };
    },
  },
  {
    name: "update_issue",
    description: "Update an issue (status, priority, resolution). Audited.",
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
      return { path: `/api/issues/${issue_id}`, method: "PATCH", body };
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
    toRequest: (args) => ({ path: `/api/projects/${args.project_id}/budget`, method: "GET" }),
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
      path: `/api/clashes?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
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
      path: `/api/resources?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
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
      "project deletion requests, change requests (raised/under review), submitted timesheets, " +
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

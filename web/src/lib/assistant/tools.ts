/**
 * Curated tool set for the NoPM assistant.
 * Every tool maps 1:1 to a REAL existing API endpoint + HTTP method.
 * The executor in index.ts calls these over HTTP with an ephemeral Bearer token.
 */

import type { ToolDefinition } from "./providers/openai";

/** Tool registry entry — schema + the HTTP call the executor makes. */
export type ToolSpec = {
  definition: ToolDefinition;
  /** Build the fetch call. Returns [url_path, method, body?] */
  toRequest: (args: Record<string, unknown>) => {
    path: string;      // e.g. "/api/projects"
    method: string;    // "GET" | "POST" | "PATCH" | "DELETE"
    body?: unknown;
  };
};

export const TOOLS: ToolSpec[] = [
  // ── Projects ─────────────────────────────────────────────────────────────
  {
    definition: {
      name: "list_projects",
      description: "List all projects in the workspace.",
      parameters: {
        type: "object",
        properties: {
          page: { type: "number", description: "Page number (default 1)" },
          limit: { type: "number", description: "Results per page (default 20, max 100)" },
        },
        required: [],
        additionalProperties: false,
      },
    },
    toRequest: (args) => ({
      path: `/api/projects?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
      method: "GET",
    }),
  },
  {
    definition: {
      name: "create_project",
      description: "Create a new project in the workspace.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Project name" },
          description: { type: "string", description: "Optional description" },
          status: { type: "string", description: "active | on_hold | completed | archived" },
          start_date: { type: "string", description: "ISO date string YYYY-MM-DD" },
          end_date: { type: "string", description: "ISO date string YYYY-MM-DD" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    toRequest: (args) => ({
      path: "/api/projects",
      method: "POST",
      body: args,
    }),
  },

  // ── Milestones ────────────────────────────────────────────────────────────
  {
    definition: {
      name: "list_milestones",
      description: "List milestones for a project.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID" },
          page: { type: "number" },
          limit: { type: "number" },
        },
        required: ["project_id"],
        additionalProperties: false,
      },
    },
    toRequest: (args) => ({
      path: `/api/projects/${args.project_id}/milestones?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
      method: "GET",
    }),
  },
  {
    definition: {
      name: "create_milestone",
      description: "Create a milestone inside a project.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID" },
          name: { type: "string", description: "Milestone name" },
          description: { type: "string" },
          due_date: { type: "string", description: "ISO date string YYYY-MM-DD" },
          status: { type: "string", description: "pending | in_progress | completed | at_risk" },
        },
        required: ["project_id", "name"],
        additionalProperties: false,
      },
    },
    toRequest: (args) => {
      const { project_id, ...body } = args;
      return { path: `/api/projects/${project_id}/milestones`, method: "POST", body };
    },
  },

  // ── Tasks ─────────────────────────────────────────────────────────────────
  {
    definition: {
      name: "list_tasks",
      description: "List tasks for a project.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID" },
          page: { type: "number" },
          limit: { type: "number" },
        },
        required: ["project_id"],
        additionalProperties: false,
      },
    },
    toRequest: (args) => ({
      path: `/api/projects/${args.project_id}/tasks?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
      method: "GET",
    }),
  },
  {
    definition: {
      name: "create_task",
      description: "Create a task inside a project.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID" },
          name: { type: "string", description: "Task name" },
          description: { type: "string" },
          status_type: {
            type: "string",
            description: "backlog | todo | in_progress | review | done | cancelled",
          },
          priority: { type: "string", description: "critical | high | medium | low" },
          assignee_id: { type: "string", description: "Profile UUID of assignee" },
          due_date: { type: "string", description: "ISO date string YYYY-MM-DD" },
          milestone_id: { type: "string", description: "Milestone UUID" },
          estimate_hours: { type: "number" },
          story_points: { type: "number" },
        },
        required: ["project_id", "name", "status_type", "priority"],
        additionalProperties: false,
      },
    },
    toRequest: (args) => {
      const { project_id, ...body } = args;
      return { path: `/api/projects/${project_id}/tasks`, method: "POST", body };
    },
  },
  {
    definition: {
      name: "request_task_deletion",
      description:
        "Request deletion of a task. Does NOT delete immediately — creates a maker-checker deletion request that must be approved by an admin/manager.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task UUID" },
          reason: { type: "string", description: "Reason for deletion" },
        },
        required: ["task_id"],
        additionalProperties: false,
      },
    },
    toRequest: (args) => ({
      path: `/api/tasks/${args.task_id}`,
      method: "DELETE",
      body: args.reason ? { reason: args.reason } : undefined,
    }),
  },

  // ── Risks ─────────────────────────────────────────────────────────────────
  {
    definition: {
      name: "list_risks",
      description: "List risks for a project.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID" },
          page: { type: "number" },
          limit: { type: "number" },
        },
        required: ["project_id"],
        additionalProperties: false,
      },
    },
    toRequest: (args) => ({
      path: `/api/projects/${args.project_id}/risks?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
      method: "GET",
    }),
  },
  {
    definition: {
      name: "create_risk",
      description: "Create a risk under a project.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID" },
          title: { type: "string", description: "Risk title" },
          description: { type: "string" },
          probability: {
            type: "string",
            description: "low | medium | high | critical",
          },
          impact: {
            type: "string",
            description: "low | medium | high | critical",
          },
          status: { type: "string", description: "open | mitigated | closed | accepted" },
          mitigation: { type: "string", description: "Mitigation plan" },
          owner_id: { type: "string", description: "Profile UUID of owner" },
        },
        required: ["project_id", "title", "probability", "impact"],
        additionalProperties: false,
      },
    },
    toRequest: (args) => {
      const { project_id, ...body } = args;
      return { path: `/api/projects/${project_id}/risks`, method: "POST", body };
    },
  },

  // ── Issues ────────────────────────────────────────────────────────────────
  {
    definition: {
      name: "list_issues",
      description: "List issues for a project.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID" },
          page: { type: "number" },
          limit: { type: "number" },
        },
        required: ["project_id"],
        additionalProperties: false,
      },
    },
    toRequest: (args) => ({
      path: `/api/projects/${args.project_id}/issues?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
      method: "GET",
    }),
  },
  {
    definition: {
      name: "create_issue",
      description: "Create an issue under a project.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID" },
          title: { type: "string", description: "Issue title" },
          description: { type: "string" },
          severity: { type: "string", description: "low | medium | high | critical" },
          status: { type: "string", description: "open | in_progress | resolved | closed" },
          assignee_id: { type: "string", description: "Profile UUID of assignee" },
        },
        required: ["project_id", "title", "severity"],
        additionalProperties: false,
      },
    },
    toRequest: (args) => {
      const { project_id, ...body } = args;
      return { path: `/api/projects/${project_id}/issues`, method: "POST", body };
    },
  },

  // ── Budget ────────────────────────────────────────────────────────────────
  {
    definition: {
      name: "get_budget",
      description: "Get the budget and actuals for a project.",
      parameters: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID" },
        },
        required: ["project_id"],
        additionalProperties: false,
      },
    },
    toRequest: (args) => ({
      path: `/api/projects/${args.project_id}/budget`,
      method: "GET",
    }),
  },

  // ── Clashes ───────────────────────────────────────────────────────────────
  {
    definition: {
      name: "list_clashes",
      description: "List resource/scheduling clashes across the workspace.",
      parameters: {
        type: "object",
        properties: {
          page: { type: "number" },
          limit: { type: "number" },
        },
        required: [],
        additionalProperties: false,
      },
    },
    toRequest: (args) => ({
      path: `/api/clashes?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
      method: "GET",
    }),
  },

  // ── Resources ─────────────────────────────────────────────────────────────
  {
    definition: {
      name: "list_resources",
      description: "List resource members in the workspace.",
      parameters: {
        type: "object",
        properties: {
          page: { type: "number" },
          limit: { type: "number" },
        },
        required: [],
        additionalProperties: false,
      },
    },
    toRequest: (args) => ({
      path: `/api/resources?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
      method: "GET",
    }),
  },

  // ── Audit ─────────────────────────────────────────────────────────────────
  {
    definition: {
      name: "query_audit",
      description:
        "Query the audit log. Filter by target_type, target_id, action, or actor_id.",
      parameters: {
        type: "object",
        properties: {
          target_type: {
            type: "string",
            description: "e.g. project | task | risk | issue | milestone | clash | resource",
          },
          target_id: { type: "string", description: "UUID of the target entity" },
          action: { type: "string", description: "e.g. task.create | task.update" },
          actor_id: { type: "string", description: "UUID of the actor" },
          page: { type: "number" },
          limit: { type: "number" },
        },
        required: [],
        additionalProperties: false,
      },
    },
    toRequest: (args) => {
      const params = new URLSearchParams();
      if (args.target_type) params.set("target_type", String(args.target_type));
      if (args.target_id) params.set("target_id", String(args.target_id));
      if (args.action) params.set("action", String(args.action));
      if (args.actor_id) params.set("actor_id", String(args.actor_id));
      params.set("page", String(args.page ?? 1));
      params.set("limit", String(args.limit ?? 20));
      return { path: `/api/audit?${params.toString()}`, method: "GET" };
    },
  },
];

/** The exact scopes this tool set requires on the ephemeral token. */
export const TOOL_SCOPES = [
  "project:read",
  "project:write",
  "milestone:read",
  "milestone:write",
  "task:read",
  "task:write",
  "task:delete:request",
  "risk:read",
  "risk:write",
  "issue:read",
  "issue:write",
  "budget:read",
  "clash:read",
  "resource:read",
  "audit:read",
] as const;

export type ToolScope = (typeof TOOL_SCOPES)[number];

#!/usr/bin/env node
/**
 * NoPM MCP server — STDIO transport.
 * Maps MCP tool calls to NoPM REST API calls authenticated with a scoped PAT.
 *
 * Config (env):
 *   NOPM_API_URL   Base URL of the NoPM API  (default: https://stillnotbald.com)
 *   NOPM_TOKEN     A scoped npm_ Bearer PAT   (required)
 *
 * Start:  node mcp/server.mjs
 * Or:     npm run mcp
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Config ──────────────────────────────────────────────────────────────────

const API_URL = (process.env.NOPM_API_URL || "https://stillnotbald.com").replace(/\/$/, "");
const TOKEN = process.env.NOPM_TOKEN;

if (!TOKEN) {
  process.stderr.write(
    "[nopm-mcp] FATAL: NOPM_TOKEN env var is not set. " +
      "Create a scoped npm_ PAT in NoPM → Settings → API Tokens and set NOPM_TOKEN.\n",
  );
  process.exit(1);
}

// ── Tool definitions ─────────────────────────────────────────────────────────
// Mirrors web/src/lib/assistant/tools.ts — least-privilege governed set.

const TOOLS = [
  // ── Projects ───────────────────────────────────────────────────────────────
  {
    name: "list_projects",
    description: "List all projects in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number", description: "Page number (default 1)" },
        limit: { type: "number", description: "Results per page (default 20, max 100)" },
      },
      required: [],
      additionalProperties: false,
    },
    toRequest(args) {
      return { path: `/api/projects?page=${args.page ?? 1}&limit=${args.limit ?? 20}`, method: "GET" };
    },
  },
  {
    name: "create_project",
    description: "Create a new project in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name" },
        description: { type: "string", description: "Optional description" },
        status: { type: "string", description: "active | on_hold | completed | archived" },
        start_date: { type: "string", description: "ISO date YYYY-MM-DD" },
        end_date: { type: "string", description: "ISO date YYYY-MM-DD" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    toRequest(args) {
      return { path: "/api/projects", method: "POST", body: args };
    },
  },

  // ── Milestones ─────────────────────────────────────────────────────────────
  {
    name: "list_milestones",
    description: "List milestones for a project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        page: { type: "number" },
        limit: { type: "number" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest(args) {
      return {
        path: `/api/projects/${args.project_id}/milestones?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
        method: "GET",
      };
    },
  },
  {
    name: "create_milestone",
    description: "Create a milestone inside a project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        name: { type: "string", description: "Milestone name" },
        description: { type: "string" },
        due_date: { type: "string", description: "ISO date YYYY-MM-DD" },
        status: { type: "string", description: "pending | in_progress | completed | at_risk" },
      },
      required: ["project_id", "name"],
      additionalProperties: false,
    },
    toRequest(args) {
      const { project_id, ...body } = args;
      return { path: `/api/projects/${project_id}/milestones`, method: "POST", body };
    },
  },

  // ── Tasks ──────────────────────────────────────────────────────────────────
  {
    name: "list_tasks",
    description: "List tasks for a project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        page: { type: "number" },
        limit: { type: "number" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest(args) {
      return {
        path: `/api/projects/${args.project_id}/tasks?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
        method: "GET",
      };
    },
  },
  {
    name: "create_task",
    description: "Create a task inside a project.",
    inputSchema: {
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
        due_date: { type: "string", description: "ISO date YYYY-MM-DD" },
        milestone_id: { type: "string", description: "Milestone UUID" },
        estimate_hours: { type: "number" },
        story_points: { type: "number" },
      },
      required: ["project_id", "name", "status_type", "priority"],
      additionalProperties: false,
    },
    toRequest(args) {
      const { project_id, ...body } = args;
      return { path: `/api/projects/${project_id}/tasks`, method: "POST", body };
    },
  },
  {
    name: "request_task_deletion",
    description:
      "Request deletion of a task. Does NOT delete immediately — creates a maker-checker " +
      "deletion request (status=pending) that must be approved by a different token with " +
      "scope task:delete:approve. Self-approval is rejected by the server (403).",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task UUID" },
        reason: { type: "string", description: "Reason for deletion (recommended for audit trail)" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    toRequest(args) {
      return {
        path: `/api/tasks/${args.task_id}`,
        method: "DELETE",
        body: args.reason ? { reason: args.reason } : undefined,
      };
    },
  },

  // ── Risks ──────────────────────────────────────────────────────────────────
  {
    name: "list_risks",
    description: "List risks for a project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        page: { type: "number" },
        limit: { type: "number" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest(args) {
      return {
        path: `/api/projects/${args.project_id}/risks?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
        method: "GET",
      };
    },
  },
  {
    name: "create_risk",
    description: "Create a risk under a project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        title: { type: "string", description: "Risk title" },
        description: { type: "string" },
        probability: { type: "string", description: "low | medium | high | critical" },
        impact: { type: "string", description: "low | medium | high | critical" },
        status: { type: "string", description: "open | mitigated | closed | accepted" },
        mitigation: { type: "string", description: "Mitigation plan" },
        owner_id: { type: "string", description: "Profile UUID of owner" },
      },
      required: ["project_id", "title", "probability", "impact"],
      additionalProperties: false,
    },
    toRequest(args) {
      const { project_id, ...body } = args;
      return { path: `/api/projects/${project_id}/risks`, method: "POST", body };
    },
  },

  // ── Issues ─────────────────────────────────────────────────────────────────
  {
    name: "list_issues",
    description: "List issues for a project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        page: { type: "number" },
        limit: { type: "number" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest(args) {
      return {
        path: `/api/projects/${args.project_id}/issues?page=${args.page ?? 1}&limit=${args.limit ?? 20}`,
        method: "GET",
      };
    },
  },
  {
    name: "create_issue",
    description: "Create an issue under a project.",
    inputSchema: {
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
    toRequest(args) {
      const { project_id, ...body } = args;
      return { path: `/api/projects/${project_id}/issues`, method: "POST", body };
    },
  },

  // ── Budget ─────────────────────────────────────────────────────────────────
  {
    name: "get_budget",
    description: "Get the budget and actuals for a project (planned, committed, actual, variance, burn_pct).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    toRequest(args) {
      return { path: `/api/projects/${args.project_id}/budget`, method: "GET" };
    },
  },

  // ── Clashes ────────────────────────────────────────────────────────────────
  {
    name: "list_clashes",
    description: "List resource/schedule/dependency clashes across the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number" },
        limit: { type: "number" },
      },
      required: [],
      additionalProperties: false,
    },
    toRequest(args) {
      return { path: `/api/clashes?page=${args.page ?? 1}&limit=${args.limit ?? 20}`, method: "GET" };
    },
  },

  // ── Resources ──────────────────────────────────────────────────────────────
  {
    name: "list_resources",
    description: "List resource members (people with cost rates and capacity) in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number" },
        limit: { type: "number" },
      },
      required: [],
      additionalProperties: false,
    },
    toRequest(args) {
      return { path: `/api/resources?page=${args.page ?? 1}&limit=${args.limit ?? 20}`, method: "GET" };
    },
  },

  // ── Audit ──────────────────────────────────────────────────────────────────
  {
    name: "query_audit",
    description:
      "Query the immutable audit log. Filter by target_type, target_id, action, or actor_id. " +
      "Every write in NoPM produces exactly one audit row.",
    inputSchema: {
      type: "object",
      properties: {
        target_type: {
          type: "string",
          description: "project | task | risk | issue | milestone | clash | resource",
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
    toRequest(args) {
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

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function callApi(path, method, body) {
  const url = API_URL + path;
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = { error: `Non-JSON response (HTTP ${res.status})` };
  }
  // Return the full envelope so { error } (incl. 403 scope errors) is visible.
  return json;
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "nopm", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// tools/list
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

// tools/call
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true,
    };
  }

  let req;
  try {
    req = tool.toRequest(args);
  } catch (err) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Bad arguments: ${err.message}` }) }],
      isError: true,
    };
  }

  const result = await callApi(req.path, req.method, req.body);

  // Surface { error } as a visible tool result (not a thrown exception) so the
  // MCP client can see governance failures (403 scope, 422 maker-checker, etc.)
  // rather than receiving an opaque transport error.
  const isError = typeof result.error === "string";
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError,
  };
});

// ── Main ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[nopm-mcp] server ready — ${TOOLS.length} tools, API: ${API_URL}\n`);

import { route } from "@/lib/api/handler";
import { z } from "zod";
import { createProjectSchema, updateProjectSchema } from "@/app/api/projects/_schema";
import { createMilestoneSchema, updateMilestoneSchema } from "@/app/api/milestones/_schema";
import {
  TaskCreateSchema,
  TaskUpdateSchema,
  TaskDeleteRequestSchema,
} from "@/app/api/tasks/_schema";
import { createRiskSchema, updateRiskSchema } from "@/app/api/risks/_schema";
import { createIssueSchema, updateIssueSchema } from "@/app/api/issues/_schema";

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

const spec = {
  openapi: "3.1.0",
  info: {
    title: "NoPM API",
    version: "0.1.0",
    description:
      "API-first project-management tool designed to be driven by AI agents. " +
      "All mutations produce an immutable audit_log entry. " +
      "Task deletion is maker-checker: DELETE /tasks/{id} creates a deletion_request; " +
      "a separate token with scope task:delete:approve must POST /deletion-requests/{id}/approve. " +
      "Every authenticated request is subject to a baseline workspace+actor-class rate limit " +
      "(fixed 60s window; defaults 600/min read, 120/min write) — see components.responses.RateLimited.",
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
          "Scopes follow resource:action convention (e.g. task:read, project:write).",
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
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/health": {
      get: {
        tags: ["system"],
        summary: "Liveness probe",
        description: "Public. No auth required.",
        security: [],
        operationId: "getHealth",
        responses: {
          "200": { description: "Service is up", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
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
    "/projects": {
      get: {
        tags: ["projects"],
        summary: "List projects",
        description: "scope: project:read",
        operationId: "listProjects",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
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
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["projects"],
        summary: "Delete a project (hard delete)",
        description: "scope: project:write",
        operationId: "deleteProject",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
          "422": { description: "project_locked — the patch touches a schedule-shape field and the project is locked", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["tasks"],
        summary: "Request task deletion (maker step)",
        description: "scope: task:delete:request. Does NOT delete the task. Creates a deletion_request with status=pending. Returns 202. A different token with scope task:delete:approve must approve it. 422 project_locked when the project is locked (deletion always reshapes the schedule).",
        operationId: "requestTaskDeletion",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: zodBody(TaskDeleteRequestSchema),
        responses: {
          "202": { description: "Deletion request created (pending)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Duplicate pending request, or project_locked when the project is locked", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/risks": {
      get: {
        tags: ["risks"],
        summary: "List risks for a project",
        description: "scope: risk:read",
        operationId: "listProjectRisks",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
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
        description: "scope: issue:read",
        operationId: "listProjectIssues",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
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
        description: "scope: time:read. Optional ?project_id and ?member_id filters.",
        operationId: "listTimeEntries",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
          { name: "project_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "member_id", in: "query", schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          "200": { description: "Paginated time entry list", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
      post: {
        tags: ["time-entries"],
        summary: "Log a time entry",
        description: "scope: time:write. Cost is auto-computed as hours * member.cost_rate.",
        operationId: "createTimeEntry",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["member_id", "project_id", "entry_date", "hours"], properties: { member_id: { type: "string", format: "uuid" }, project_id: { type: "string", format: "uuid" }, task_id: { type: "string", format: "uuid" }, entry_date: { type: "string", format: "date" }, hours: { type: "number", minimum: 0 }, note: { type: "string" } } } } } },
        responses: {
          "201": { description: "Time entry created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/time-entries/{id}": {
      delete: {
        tags: ["time-entries"],
        summary: "Delete a time entry",
        description: "scope: time:write",
        operationId: "deleteTimeEntry",
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
        description: "scope: task:delete:approve. Four-eyes: approver must differ from requester. Atomically deletes the target and commits the request.",
        operationId: "approveDeletionRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Deletion committed", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Self-approval rejected", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Request already decided", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/deletion-requests/{id}/reject": {
      post: {
        tags: ["deletion-requests"],
        summary: "Reject a pending deletion request (checker step)",
        description: "scope: task:delete:approve. Four-eyes: the decider must differ from the requester — self-rejection returns 422. A maker cancels their own request via /withdraw instead.",
        operationId: "rejectDeletionRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string" } } } } } },
        responses: {
          "200": { description: "Request rejected", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Request already decided, or self-rejection (four-eyes)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/deletion-requests/{id}/withdraw": {
      post: {
        tags: ["deletion-requests"],
        summary: "Withdraw your own pending deletion request (maker step)",
        description: "scope: task:delete:request. Only the ORIGINAL requester may withdraw, and only while the request is pending. Cancels the request without a checker decision; audited as deletion_request.withdrawn.",
        operationId: "withdrawDeletionRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Request withdrawn", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Caller is not the original requester", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Request already decided", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/audit": {
      get: {
        tags: ["audit"],
        summary: "Query the immutable audit log",
        description: "scope: audit:read. Filters: ?target_type, ?target_id, ?action, ?actor_id.",
        operationId: "listAuditLog",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 50, minimum: 1, maximum: 100 } },
          { name: "target_type", in: "query", schema: { type: "string" } },
          { name: "target_id", in: "query", schema: { type: "string", format: "uuid" } },
          { name: "action", in: "query", schema: { type: "string" } },
          { name: "actor_id", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Paginated audit log entries", content: { "application/json": { schema: { $ref: "#/components/schemas/SuccessList" } } } },
        },
      },
    },
    "/auth/mfa": {
      get: {
        tags: ["auth"],
        summary: "Get MFA status for the current user",
        description: "scope: user session only",
        operationId: "getMfaStatus",
        responses: {
          "200": { description: "MFA status", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "401": { description: "Not a user session", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
    "/search": {
      get: {
        tags: ["system"],
        summary: "Full-workspace record search",
        description: "scope: project:read. Case-insensitive search across projects, tasks, risks, issues, clashes, documents, change_requests, and decisions. ?q=<query> (min 1 char). Returns up to 30 results.",
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
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["path", "file_name", "mime_type", "file_size"], properties: { path: { type: "string" }, file_name: { type: "string" }, mime_type: { type: "string" }, file_size: { type: "integer" } } } } } },
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
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["file_name", "mime_type", "file_size"], properties: { file_name: { type: "string" }, mime_type: { type: "string" }, file_size: { type: "integer", description: "Bytes, max 26214400 (25 MiB)" } } } } } },
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
        description: "scope: change:write. Auto-assigns a CR-NNN reference_id.",
        operationId: "createChangeRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["title", "category", "priority", "status"], properties: { title: { type: "string" }, description: { type: "string" }, category: { type: "string" }, priority: { type: "string", enum: ["low", "medium", "high", "critical"] }, status: { type: "string" }, impact_summary: { type: "string" }, impact_schedule_days: { type: "integer" }, impact_cost: { type: "number" }, target_date: { type: "string", format: "date" }, raised_at: { type: "string", format: "date-time" } } } } } },
        responses: {
          "201": { description: "Change request created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
        description: "scope: change:write",
        operationId: "updateChangeRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, category: { type: "string" }, priority: { type: "string" }, impact_summary: { type: "string" }, impact_schedule_days: { type: "integer" }, impact_cost: { type: "number" }, target_date: { type: "string", format: "date" }, raised_at: { type: "string", format: "date-time" } } } } } },
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
        description: "scope: change:write. The deciding actor must differ from the requester (four-eyes). Status must be raised or under_review.",
        operationId: "decideChangeRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["decision"], properties: { decision: { type: "string", enum: ["approve", "reject", "defer"] }, rationale: { type: "string" } } } } } },
        responses: {
          "200": { description: "Decision recorded", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Self-approval rejected", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Already decided", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/projects/{id}/decisions": {
      get: {
        tags: ["decisions"],
        summary: "List decisions for a project",
        description: "scope: decision:read",
        operationId: "listProjectDecisions",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
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
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["title", "status"], properties: { title: { type: "string" }, context: { type: "string" }, options: { type: "string" }, decision: { type: "string" }, rationale: { type: "string" }, status: { type: "string" }, decided_at: { type: "string", format: "date-time" }, supersedes: { type: "string", format: "uuid" } } } } } },
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
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" }, context: { type: "string" }, options: { type: "string" }, decision: { type: "string" }, rationale: { type: "string" }, status: { type: "string" }, decided_at: { type: "string", format: "date-time" }, supersedes: { type: "string", format: "uuid" } } } } } },
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
        description: "scope: project:write. Clears is_locked, locked_by, locked_at, lock_reason.",
        operationId: "unlockProject",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
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
        description: "scope: rebaseline:approve. The requester may not sign off their own rebaseline.",
        operationId: "signoffRebaseline",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["vote"], properties: { vote: { type: "string", enum: ["go", "no_go", "pending"] }, comment: { type: "string" } } } } } },
        responses: {
          "200": { description: "Signoff recorded; rebaseline status may update", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Self-signoff rejected", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/rebaselines/{id}/apply": {
      post: {
        tags: ["rebaselines"],
        summary: "Apply an approved rebaseline (four-eyes)",
        description: "scope: rebaseline:approve. Only approved rebaselines may be applied. The requester may not apply their own rebaseline. Overwrites baseline dates for all milestones and tasks in the project.",
        operationId: "applyRebaseline",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "200": { description: "Rebaseline applied", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "403": { description: "Self-apply rejected or wrong status", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
        description: "scope: audit:read. ?format=html|pptx|pdf (default html). Optional ?sections=cover,rag,evm.",
        operationId: "getDeckReport",
        parameters: [
          { name: "format", in: "query", schema: { type: "string", enum: ["html", "pptx", "pdf"], default: "html" } },
          { name: "sections", in: "query", schema: { type: "string" }, description: "Comma-separated section keys" },
        ],
        responses: {
          "200": { description: "Report file (binary or HTML)" },
          "422": { description: "Invalid format", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["reports"],
        summary: "Generate portfolio deck report (POST variant)",
        description: "scope: audit:read. Same as GET but accepts a JSON body { format?, sections? } for structured agent use.",
        operationId: "postDeckReport",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { format: { type: "string", enum: ["html", "pptx", "pdf"] }, sections: { type: "array", items: { type: "string" } } } } } } },
        responses: {
          "200": { description: "Report file (binary or HTML)" },
          "422": { description: "Invalid format", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/reports/project/{id}": {
      get: {
        tags: ["reports"],
        summary: "Generate per-project status report",
        description: "scope: audit:read. ?format=html|pptx|pdf (default html). Optional ?sections=cover,rag,evm,risks,issues,milestones.",
        operationId: "getProjectReport",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          { name: "format", in: "query", schema: { type: "string", enum: ["html", "pptx", "pdf"], default: "html" } },
          { name: "sections", in: "query", schema: { type: "string" }, description: "Comma-separated section keys" },
        ],
        responses: {
          "200": { description: "Report file (binary or HTML)" },
          "404": { description: "Project not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "422": { description: "Invalid format", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      post: {
        tags: ["reports"],
        summary: "Generate per-project status report (POST variant)",
        description: "scope: audit:read. Same as GET but accepts a JSON body { format?, sections? } for structured agent use.",
        operationId: "postProjectReport",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { format: { type: "string", enum: ["html", "pptx", "pdf"] }, sections: { type: "array", items: { type: "string" } } } } } } },
        responses: {
          "200": { description: "Report file (binary or HTML)" },
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
  },
};

export const GET = route(async () => Response.json(spec), { auth: false });

// Exported for the openapi-coverage drift test only.
// Do NOT import this in production application code.
export const specForTesting = spec;

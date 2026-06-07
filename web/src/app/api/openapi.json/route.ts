import { route } from "@/lib/api/handler";

export const runtime = "nodejs";

const spec = {
  openapi: "3.1.0",
  info: {
    title: "NoPM API",
    version: "0.1.0",
    description:
      "API-first project-management tool designed to be driven by AI agents. " +
      "All mutations produce an immutable audit_log entry. " +
      "Task deletion is maker-checker: DELETE /tasks/{id} creates a deletion_request; " +
      "a separate token with scope task:delete:approve must POST /deletion-requests/{id}/approve.",
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
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, description: { type: "string" }, status: { type: "string" }, start_date: { type: "string", format: "date" }, end_date: { type: "string", format: "date" } } } } } },
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
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, status: { type: "string" }, start_date: { type: "string", format: "date" }, end_date: { type: "string", format: "date" } } } } } },
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
        description: "scope: milestone:write",
        operationId: "createMilestone",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, target_date: { type: "string", format: "date" }, status: { type: "string" }, completion_pct: { type: "number" }, owner_id: { type: "string", format: "uuid" }, sort_order: { type: "integer" } } } } } },
        responses: {
          "201": { description: "Milestone created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
        description: "scope: milestone:write",
        operationId: "updateMilestone",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, target_date: { type: "string", format: "date" }, status: { type: "string" }, completion_pct: { type: "number" }, owner_id: { type: "string", format: "uuid" }, sort_order: { type: "integer" } } } } } },
        responses: {
          "200": { description: "Updated milestone", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["milestones"],
        summary: "Delete a milestone",
        description: "scope: milestone:write",
        operationId: "deleteMilestone",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          "204": { description: "Deleted" },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
        description: "scope: task:write",
        operationId: "createTask",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name", "status_type"], properties: { name: { type: "string" }, description: { type: "string" }, milestone_id: { type: "string", format: "uuid" }, status_type: { type: "string" }, status: { type: "string" }, assignee_id: { type: "string", format: "uuid" }, priority: { type: "string" }, start_date: { type: "string", format: "date" }, due_date: { type: "string", format: "date" }, completion_pct: { type: "number" }, sort_order: { type: "integer" } } } } } },
        responses: {
          "201": { description: "Task created", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
        description: "scope: task:write. Kanban status moves are audited.",
        operationId: "updateTask",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, status_type: { type: "string" }, status: { type: "string" }, assignee_id: { type: "string", format: "uuid" }, priority: { type: "string" }, start_date: { type: "string", format: "date" }, due_date: { type: "string", format: "date" }, completion_pct: { type: "number" }, sort_order: { type: "integer" } } } } } },
        responses: {
          "200": { description: "Updated task", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["tasks"],
        summary: "Request task deletion (maker step)",
        description: "scope: task:delete:request. Does NOT delete the task. Creates a deletion_request with status=pending. Returns 202. A different token with scope task:delete:approve must approve it.",
        operationId: "requestTaskDeletion",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string" } } } } } },
        responses: {
          "202": { description: "Deletion request created (pending)", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
          "422": { description: "Duplicate pending request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
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
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["title", "severity", "likelihood", "status"], properties: { title: { type: "string" }, description: { type: "string" }, severity: { type: "string" }, likelihood: { type: "string" }, category: { type: "string" }, mitigation: { type: "string" }, owner_id: { type: "string", format: "uuid" }, status: { type: "string" }, raised_at: { type: "string", format: "date-time" }, due_date: { type: "string", format: "date" } } } } } },
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
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, severity: { type: "string" }, likelihood: { type: "string" }, category: { type: "string" }, mitigation: { type: "string" }, owner_id: { type: "string", format: "uuid" }, status: { type: "string" }, raised_at: { type: "string", format: "date-time" }, due_date: { type: "string", format: "date" } } } } } },
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
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["title", "priority", "status"], properties: { title: { type: "string" }, description: { type: "string" }, priority: { type: "string" }, resolution: { type: "string" }, owner_id: { type: "string", format: "uuid" }, status: { type: "string" }, raised_at: { type: "string", format: "date-time" }, due_date: { type: "string", format: "date" } } } } } },
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
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, priority: { type: "string" }, resolution: { type: "string" }, owner_id: { type: "string", format: "uuid" }, status: { type: "string" }, raised_at: { type: "string", format: "date-time" }, due_date: { type: "string", format: "date" } } } } } },
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
        description: "scope: task:read or audit:read. Optional ?status filter (pending|approved|rejected|committed).",
        operationId: "listDeletionRequests",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, minimum: 1, maximum: 100 } },
          { name: "status", in: "query", schema: { type: "string", enum: ["pending", "approved", "rejected", "committed"] } },
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
        summary: "Reject a pending deletion request",
        description: "scope: task:delete:approve. Self-rejection is allowed.",
        operationId: "rejectDeletionRequest",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string" } } } } } },
        responses: {
          "200": { description: "Request rejected", content: { "application/json": { schema: { $ref: "#/components/schemas/Success" } } } },
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
  },
};

export const GET = route(async () => Response.json(spec), { auth: false });

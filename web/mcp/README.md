# NoPM MCP Server

A native STDIO Model Context Protocol (MCP) server that lets any MCP client — Claude Desktop, Cursor, Continue, or a custom agent — drive NoPM as a governed agent.

NoPM bundles no LLM. This server is a thin bridge: it maps MCP tool calls to NoPM REST API calls authenticated with a scoped Bearer PAT. All governance (audit trail, PAT scopes, maker-checker on task deletion) is enforced server-side.

---

## Quick start

### 1. Create a scoped PAT

Sign in to NoPM → **Settings → API Tokens → New Token**.
Select the scopes your agent needs (see below) and copy the token — it is shown exactly once.

### 2. Register in your MCP client

#### Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "nopm": {
      "command": "node",
      "args": ["/absolute/path/to/NoPM/web/mcp/server.mjs"],
      "env": {
        "NOPM_API_URL": "https://stillnotbald.com",
        "NOPM_TOKEN": "npm_your_token_here"
      }
    }
  }
}
```

Replace `/absolute/path/to/NoPM/web/mcp/server.mjs` with the real absolute path on your machine.

#### Cursor / Continue / other MCP clients

Use the same `command`, `args`, and `env` block — the format varies by client but the values are identical.

### 3. Verify

Restart your MCP client. In Claude Desktop you should see the NoPM tools in the tool picker. Ask: *"List my NoPM projects"* — the agent will call `list_projects` and return the results.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `NOPM_TOKEN` | (required) | A scoped `npm_` PAT. The server exits immediately if this is absent. |
| `NOPM_API_URL` | `https://stillnotbald.com` | Base URL of the NoPM API. Override to point at a local dev server. |

---

## Tool catalogue

| Tool | Method | Scope required |
|---|---|---|
| `list_projects` | GET /api/projects | `project:read` |
| `create_project` | POST /api/projects | `project:write` |
| `list_milestones` | GET /api/projects/:id/milestones | `milestone:read` |
| `create_milestone` | POST /api/projects/:id/milestones | `milestone:write` |
| `list_tasks` | GET /api/projects/:id/tasks | `task:read` |
| `create_task` | POST /api/projects/:id/tasks | `task:write` |
| `request_task_deletion` | DELETE /api/tasks/:id | `task:delete:request` |
| `list_risks` | GET /api/projects/:id/risks | `risk:read` |
| `create_risk` | POST /api/projects/:id/risks | `risk:write` |
| `list_issues` | GET /api/projects/:id/issues | `issue:read` |
| `create_issue` | POST /api/projects/:id/issues | `issue:write` |
| `get_budget` | GET /api/projects/:id/budget | `budget:read` |
| `list_clashes` | GET /api/clashes | `clash:read` |
| `list_resources` | GET /api/resources | `resource:read` |
| `query_audit` | GET /api/audit | `audit:read` |

### Recommended minimum scopes for a read-only agent

```
project:read  milestone:read  task:read  risk:read
issue:read  budget:read  clash:read  resource:read  audit:read
```

### Recommended scopes for a read-write agent

All of the above plus:

```
project:write  milestone:write  task:write  task:delete:request
risk:write  issue:write
```

---

## Governance guarantees

- **Capabilities are bounded by the PAT scopes.** A `project:read`-only token cannot create projects. The server surfaces `{ "error": "..." }` (including 403 scope errors) as the tool result so governance failures are visible — they are never silently swallowed.

- **Every write produces an immutable audit log row.** You can inspect the trail at any time with the `query_audit` tool.

- **Task deletion is maker-checker.** `request_task_deletion` calls `DELETE /api/tasks/:id`, which creates a `deletion_request` with `status=pending` and returns 202 Accepted — the task is NOT deleted. A second, different token with scope `task:delete:approve` must call `POST /api/deletion-requests/:id/approve`. Self-approval is rejected by the server (403). This server intentionally exposes only the maker (request) side; the checker (approve) step must be performed by an authorized human or a separate token through the NoPM UI or API directly.

---

## Running the smoke test

From `web/`:

```sh
node scripts/mcp-smoke.mjs
```

The script reads `NOPM_TOKEN` (or `NOPM_MAKER_TOKEN`) and `NEXT_PUBLIC_APP_URL` from `web/.env.local`, spawns the MCP server, runs `tools/list` and `list_projects`, and prints the results.

---

## Development

```sh
# from web/
npm run mcp          # start the server (NOPM_TOKEN must be set in env)
node --check mcp/server.mjs   # syntax check only
```

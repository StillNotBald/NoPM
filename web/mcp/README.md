# NoPM MCP Server

A native Model Context Protocol (MCP) server, in two transports, that lets any MCP client — Claude Desktop, Claude Code, claude.ai Connectors, Cursor, Continue, or a custom agent — drive NoPM as a governed agent:

- **STDIO** (`web/mcp/server.mjs`) — a local process, for local MCP clients (Claude Desktop, Claude Code, Cursor).
- **Streamable HTTP** (`/api/mcp` on the deployed app) — a remote endpoint, for hosted/remote MCP clients (claude.ai Connectors, or any client that speaks Streamable HTTP).

Both transports share one tool registry (`web/mcp/tools.mjs` — the same registry the in-app BYOK assistant uses) and the same governance posture: neither transport holds privileged credentials of its own. All capability is bounded by whatever scoped `npm_` PAT the caller supplies; the underlying REST API enforces scopes, audit, and maker-checker unchanged.

NoPM bundles no LLM. This server is a thin bridge: it maps MCP tool calls to NoPM REST API calls authenticated with a scoped Bearer PAT. All governance (audit trail, PAT scopes, maker-checker on task and project deletion) is enforced server-side.

---

## Quick start

### 1. Create a scoped PAT

Sign in to NoPM → **Settings → API Tokens → New Token**.
Select the scopes your agent needs (see below) and copy the token — it is shown exactly once.

### 2. Register in your MCP client

#### Claude Code (zero config)

A cloned repo already contains `.mcp.json` at the root. Set `NOPM_TOKEN` in your environment and open the repo in Claude Code — the `nopm` tools appear automatically.

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

#### Cursor / Continue / other local MCP clients

Use the same `command`, `args`, and `env` block — the format varies by client but the values are identical.

#### claude.ai Connectors (remote, no local process)

`claude.ai` → **Settings → Connectors → Add custom connector**:

- **Name**: `NoPM`
- **URL**: `https://stillnotbald.com/api/mcp`
- **Authentication**: send `Authorization: Bearer npm_your_token_here` as a custom header, if your claude.ai connector UI offers a header field. Not every client surfaces a plain-header option for custom connectors — some expect OAuth. If yours doesn't accept a static header, use a local bridge instead (e.g. `npx mcp-remote https://stillnotbald.com/api/mcp --header "Authorization: Bearer npm_your_token_here"`) registered as a normal local MCP server.

There is no separate "local dev" URL config for this transport beyond pointing it at wherever the app is reachable — for local development point it at `http://localhost:3000/api/mcp` (or whatever port `next dev` bound to) instead.

### 3. Verify

Restart your MCP client. You should see the NoPM tools in its tool picker. Ask: *"List my NoPM projects"* — the agent will call `list_projects` and return the results.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `NOPM_TOKEN` | (required) | A scoped `npm_` PAT. The server exits immediately if this is absent. |
| `NOPM_API_URL` | `https://stillnotbald.com` | Base URL of the NoPM API. Override to point at a local dev server. |

---

## Tool catalogue

Tool definitions live in [`tools.mjs`](./tools.mjs) — the **same registry the in-app assistant uses**, so the two agent surfaces cannot drift apart. Field names and enums are lock-tested against the API's Zod validators (`web/src/lib/assistant/tools-zod.test.ts`).

| Tool | Method | Scope required |
|---|---|---|
| `list_projects` | GET /api/projects | `project:read` |
| `get_project` | GET /api/projects/:id | `project:read` |
| `create_project` | POST /api/projects | `project:write` |
| `update_project` | PATCH /api/projects/:id | `project:write` |
| `request_project_deletion` | DELETE /api/projects/:id | `project:delete:request` |
| `list_milestones` | GET /api/projects/:id/milestones | `milestone:read` |
| `create_milestone` | POST /api/projects/:id/milestones | `milestone:write` |
| `update_milestone` | PATCH /api/milestones/:id | `milestone:write` |
| `list_tasks` | GET /api/projects/:id/tasks | `task:read` |
| `get_task` | GET /api/tasks/:id | `task:read` |
| `create_task` | POST /api/projects/:id/tasks | `task:write` |
| `update_task` | PATCH /api/tasks/:id (the governed Kanban move) | `task:write` |
| `request_task_deletion` | DELETE /api/tasks/:id | `task:delete:request` |
| `list_risks` | GET /api/projects/:id/risks | `risk:read` |
| `create_risk` | POST /api/projects/:id/risks | `risk:write` |
| `update_risk` | PATCH /api/risks/:id | `risk:write` |
| `list_issues` | GET /api/projects/:id/issues | `issue:read` |
| `create_issue` | POST /api/projects/:id/issues | `issue:write` |
| `update_issue` | PATCH /api/issues/:id | `issue:write` |
| `get_budget` | GET /api/projects/:id/budget | `budget:read` |
| `list_clashes` | GET /api/clashes | `clash:read` |
| `list_resources` | GET /api/resources | `resource:read` |
| `search_workspace` | GET /api/search | `project:read` |
| `query_audit` | GET /api/audit | `audit:read` |
| `list_pending_approvals` | GET /api/review (read-only — lists, never decides) | any of `task:read` / `audit:read` / `change:read` / `time:read` / `project:read`; each kind needs its own read scope, others are named in `hidden_kinds` |

### Recommended minimum scopes for a read-only agent

```
project:read  milestone:read  task:read  risk:read
issue:read  budget:read  clash:read  resource:read  audit:read
```

### Recommended scopes for a read-write agent

All of the above plus:

```
project:write  project:delete:request  milestone:write  task:write  task:delete:request
risk:write  issue:write
```

---

## Governance guarantees

- **Capabilities are bounded by the PAT scopes.** A `project:read`-only token cannot create projects. The server surfaces `{ "error": "..." }` (including 403 scope errors) as the tool result so governance failures are visible — they are never silently swallowed.

- **A tool can only reach its own endpoint.** Tool arguments are model-controlled text, so every id that goes into a request path (`project_id`, `task_id`, `milestone_id`, `risk_id`, `issue_id`) must be a UUID and is percent-encoded; anything else (`../unlock`, `<uuid>/../tokens`, `<uuid>?x=`) is refused with a `Bad arguments: <field> must be a UUID` tool result BEFORE any request is made. As a second layer, every built request is checked against the shape of its own tool's route (same method, same path segments, no encoded or dotted segments), so a tool cannot be steered onto a route that is not a tool, such as `POST /api/projects/:id/unlock`. `page` / `limit` are encoded and can only be query values. Locked by `src/lib/assistant/tools-path-safety.test.ts`.

- **Every write produces an immutable audit log row.** You can inspect the trail at any time with the `query_audit` tool.

- **Every write is tagged with its declared client.** Both transports send `X-NoPM-Client: mcp`, so the resulting audit_log rows carry `channel: mcp` (R-82, filterable via `GET /audit?channel=mcp`) — provenance only, never an authorization input; token identity stays authoritative.

- **Task deletion AND project deletion are maker-checker.** `request_task_deletion` calls `DELETE /api/tasks/:id`; `request_project_deletion` calls `DELETE /api/projects/:id`. Both create a `deletion_request` (`status=pending`, `target_type=task` or `target_type=project`) and return 202 Accepted — the target is NOT deleted. A different person (a token counts as the human who created it, so a second token minted by the requester does not count) with the scope matching the request's `target_type` (`task:delete:approve` for tasks, `project:delete:approve` for projects) must call `POST /api/deletion-requests/:id/approve`, which dispatches by `target_type` to the matching commit path. Self-approval is rejected by the server (403). This server intentionally exposes only the maker (request) side for both entity types; the checker (approve) step must be performed by an authorized human or a separate token through the NoPM UI or API directly. Maker-checker is owner-locked to PROJECTS ONLY beyond tasks — milestones/risks/issues stay single-step hard deletes and are not part of this flow.

---

## Recipe: Slack thread to governed decision

NoPM's MCP server ships no `create_decision` tool (the tool catalogue above is deliberately read-heavy plus the maker side of task/project deletion). To turn a Slack thread into a governed decision record, drive the REST API directly, either from your agent or with the `nopm` CLI:

1. Attach a Slack MCP server and the NoPM MCP server (or just a scoped NoPM PAT) to one Claude session.
2. Ask it to summarise the thread: title, context, and rationale for the call that was made.
3. Have it call `POST /api/projects/:id/decisions` (or run `nopm decisions create --project <id> --title <t> --decision <d> --rationale <r> --context <c> --source slack --external-ref <permalink-id> --external-url <permalink>`) with the thread's permalink as `external_ref`/`external_url` and `source: slack` (R-81).
4. The resulting `decision.create` audit row carries `channel: mcp` if the write went through this server, or `channel: cli` if it went through the CLI (R-82) — either way the decision is traceable back to the exact Slack message that prompted it.

## Recipe: tail the audit log into Slack

Turn NoPM's audit trail into a running feed in a Slack channel — no webhooks, no polling infra, just an agent that wakes up on an interval. This is the outbound story R-85's cursor params exist for.

1. Attach both the NoPM MCP server and a Slack MCP server to one Claude session (or a scheduled/cron-driven agent — see the `/schedule` or `/loop` workflow if you're running this from Claude Code).
2. Every N minutes, ask the agent to call `query_audit` with `since` set to the `created_at` of the last row it posted last time (start with "5 minutes ago" on the first run), `order: "asc"` so rows come back oldest-first, and an optional `channel` filter if you only care about one surface (e.g. `channel: "cli"` to watch agent-driven writes only).
3. Have it post one line per returned row to the Slack channel — e.g. `[created_at] actor_label action target_type/target_id` — and remember the `created_at` (or `id`, to pass as `after_id` next time instead of `since`) of the last row for the next poll.
4. The `request_id` on each row lets a reader correlate every row from a single agent turn or CLI invocation — useful when one write cascades into several audit rows (e.g. a maker-checker commit) and you want to group them in the Slack thread.

This is read-only (scope `audit:read` is enough) and produces no new writes of its own — the audit log stays the single source of truth; Slack is just a mirror.

## Running the smoke tests

From `web/`:

```sh
node scripts/mcp-smoke.mjs        # STDIO transport (spawns mcp/server.mjs)
node scripts/mcp-http-smoke.mjs   # Streamable HTTP transport (hits /api/mcp)
```

Both scripts read `NOPM_TOKEN` (or `NOPM_MAKER_TOKEN`) from `web/.env.local`, run `tools/list` and `tools/call list_projects`, and print the results. `mcp-smoke.mjs` also reads `NEXT_PUBLIC_APP_URL` (the REST API it proxies to). `mcp-http-smoke.mjs` targets `NOPM_HTTP_MCP_URL` (default `http://localhost:3000/api/mcp`) and additionally checks that a request with no `Authorization` header gets a 401 — requires the dev server (`npm run dev`) running first.

---

## Development

```sh
# from web/
npm run mcp          # start the STDIO server (NOPM_TOKEN must be set in env)
node --check mcp/server.mjs   # syntax check only
npm run dev           # Streamable HTTP transport is just src/app/api/mcp/route.ts — runs with the app
```

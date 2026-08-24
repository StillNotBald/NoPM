# ADR 0007 — Native MCP server (agent-operable surface)

**Date:** 2026-06-10 · **Status:** Accepted

## Context
NoPM's thesis is "an API-first PM tool a user's own AI agent operates — like the aws/supabase CLIs — bundling no LLM." We already expose a REST API, an OpenAPI spec, a `/llms.txt` index, a `nopm` CLI, and a BYOK in-app assistant. The Model Context Protocol (MCP) is the emerging standard for connecting agents (Claude Desktop, IDEs, custom agents) to tools. Shipping a native MCP server makes "any agent can drive NoPM, under governance" literal — the strongest expression of the thesis.

## Decision
Ship a standalone **stdio MCP server** (`web/mcp/server.mjs`, `@modelcontextprotocol/sdk`) that maps MCP tool calls 1:1 to NoPM's REST API, authenticated by a **scoped `npm_` PAT** (`NOPM_TOKEN`) against `NOPM_API_URL`. It is a thin adapter — it holds **no** model and **no** privileged credentials of its own; every capability is bounded by the PAT's scopes, every write is audited as a token actor, and task deletes bounce to maker-checker. A 403 from a missing scope surfaces as a tool error rather than being bypassed. It is a CLI artifact (not part of the Next/Vercel bundle); users register it in their MCP client with their own PAT.

## Why this preserves the constitution
- **No bundled LLM** — the agent (the MCP *client*) brings the model; NoPM provides only governed tools.
- **Governance is in the data/API layer** — scopes, immutable audit, four-eyes all apply unchanged; the MCP layer can't weaken them.
- **Least privilege** — the tool set mirrors the assistant's (15 read/create/request tools); it deliberately has no approve/admin/token tools (a PAT minted for it should carry only the scopes it needs).

## Consequences
- New dependency `@modelcontextprotocol/sdk` (server-only; not imported by the web app, except for the HTTP transport route below).
- Verified end-to-end: an MCP client → server → live `https://stillnotbald.com` API with a scoped PAT returns the tool list + `list_projects` (6 projects).
- Future: deriving the tool set from the OpenAPI spec (the assistant already has an OpenAPI↔tools drift+least-privilege test that this can share).

## Update 2026-08-24 — remote Streamable HTTP transport

Added `web/src/app/api/mcp/route.ts`, a second transport for the same `TOOL_REGISTRY` (`web/mcp/tools.mjs`), using the SDK's `WebStandardStreamableHTTPServerTransport` (Fetch-API-native, so it runs as a normal Next.js route handler — no separate server process). This is what makes NoPM addable as a **remote MCP connector** (e.g. `claude.ai` → Settings → Connectors), where a local stdio process isn't an option.

Same governance posture as the stdio server, just per-request instead of per-process:
- No token is baked into the deployment. Each HTTP request must carry its own `Authorization: Bearer npm_...` PAT, forwarded verbatim to this same origin's REST API for that single request — the route holds no privileged credential of its own.
- A request with no `Authorization` header at all is rejected with 401 before touching any tool logic. A present-but-invalid/expired/under-scoped token is **not** pre-validated by this route — it flows through to the REST API exactly like the stdio server, and any resulting `{ error }` (401/403/422) is surfaced as a normal tool result, never swallowed.
- Stateless mode (`sessionIdGenerator: undefined`) — a fresh `Server` + transport is built per HTTP request, matching Vercel's serverless execution model; nothing about a caller's identity is held in memory across requests.

Verified end-to-end against a local dev server: `initialize` handshake, `tools/list` (24 tools), `tools/call list_projects` (live data via a real PAT), and a bare unauthenticated POST returning 401 — see `web/scripts/mcp-http-smoke.mjs`.

Not done as part of this update: OAuth for the connector (some MCP clients require it to auto-discover a remote server rather than accepting a static bearer header) and CORS (not needed for the claude.ai server-to-server call pattern this was verified against).

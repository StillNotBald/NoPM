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
- New dependency `@modelcontextprotocol/sdk` (server-only; not imported by the web app).
- Verified end-to-end: an MCP client → server → live `https://stillnotbald.com` API with a scoped PAT returns the tool list + `list_projects` (6 projects).
- Future: an SSE/HTTP transport for hosted use; deriving the tool set from the OpenAPI spec (the assistant already has an OpenAPI↔tools drift+least-privilege test that this can share).

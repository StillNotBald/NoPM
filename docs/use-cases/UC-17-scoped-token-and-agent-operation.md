# UC-17 · Scoped token minting and agent operation (CLI/MCP)

**Goal:** Give an AI agent (or a script) exactly the capability it needs to operate NoPM, and nothing more, by minting a scoped Personal Access Token and connecting it through the CLI or an MCP client.

**Actors:** Admin / manager session (mints and revokes tokens — token management is user-session only, not itself token-callable). AI agent via token (operates once connected).

**Preconditions:** An admin/manager is signed in.

**Trigger:** Someone wants to connect Claude Code, Claude Desktop, Cursor, or a shell script to their NoPM workspace.

## Main flow

1. Mint a token: UI `/tokens` → "Mint token", or `POST /api/tokens` (admin/manager **session** only — token actors cannot mint tokens for themselves). Pick scopes from `scopeChoices()` (derived from the live scope registry, `web/src/lib/auth/scopes.ts` — so the mint UI can never silently drift out of sync with a newly added scope again, R-86). A "least-privilege agent preset" (`AGENT_PRESET_SCOPES`, R-70/L-49) offers every read scope plus `task:write` in one click: read access to everything, the ability to edit tasks, and nothing that can delete, approve, or manage other tokens. The mint UI also lists the approve and decide scopes (`task:delete:approve`, `project:delete:approve`, `change:decide`, `rebaseline:approve`). A `<resource>:*` wildcard such as `task:*` never grants them; each must be selected by exact name.
2. The raw token (`npm_…`) is shown **exactly once**; it is stored server-side only as a SHA-256 hash, never logged, never retrievable again.
3. CLI setup: `nopm auth set-token npm_xxx --url https://stillnotbald.com`, then `nopm whoami` to confirm actor + scopes. Every CLI request sends `X-NoPM-Client: cli`, tagging its audit rows `channel: cli`.
4. MCP setup (stdio): set `NOPM_TOKEN` env var, point Claude Code/Desktop/Cursor at `web/mcp/server.mjs` (a cloned repo's root `.mcp.json` makes this zero-config for Claude Code). MCP setup (Streamable HTTP, remote): register `https://stillnotbald.com/api/mcp` as a connector with `Authorization: Bearer npm_…`. Both transports send `X-NoPM-Client: mcp`.
5. Operate: any of the 25 MCP tools, or any `nopm` CLI command, calls the same governed REST API a human uses — same scopes, same audit, same maker-checker. A `project:read`-only token cannot create a project; the server surfaces a `403` scope error as the tool result, never silently swallowed.
6. Token-authenticated callers use the admin client (RLS-bypassing) internally, but are always filtered by `actor.workspaceId` server-side — a token can never reach outside its own workspace regardless of scope.
7. Revoke: `/tokens` → Revoke (admin/manager session), or `DELETE /api/tokens/{id}`. Sets `revoked = true` immediately; the token's next call fails scope checks. There is no separate "disable" state, and revoke is not reversible. Revoking a token that is already revoked is `409` `already_revoked` ("Token already revoked"); only user tokens can be revoked here, not the assistant's short-lived ones.

## Alternate and exception flows

- **A token tries to mint/revoke another token** → `403` — token management is user-session only.
- **An agent calls an endpoint outside its granted scopes** → `403`, returned as an ordinary tool result over MCP (never a swallowed connection error) or an ordinary API error over the CLI/REST.
- **Task or project deletion via an agent** → the MCP tool set only exposes the maker side (`request_task_deletion`, `request_project_deletion`); the checker (approve) step must be taken by a different person through the UI or API (UC-12). A token can take it only if its owner is that person.
- **Approve or decide via an agent** → none of the 25 MCP tools and no assistant tool carries an approve, decide or sign-off scope. A token holding one (granted by exact name) can still call the matching endpoint or the `nopm` approve and decide commands, and four-eyes applies: the approver must be a different person from the requester.
- **Checking what is waiting for a person** → the read-only `list_pending_approvals` MCP tool and the `nopm review` command list the pending deletions, change requests and rebaselines, with whether this token may decide each one; neither approves anything.
- **Rate limiting** — a DB-backed fixed-window limiter keyed on workspace + actor class survives per-turn ephemeral assistant tokens and serverless cold starts; a limit hit is `429` `rate_limited`, logged as a `rate.limited` audit row; the limiter itself fails open (never blocks traffic) on its own infrastructure error.

## Postconditions

- `token.create`/`token.revoke` audit rows for the management actions.
- Every subsequent agent-driven write carries `channel: cli`/`channel: mcp` and a `request_id` on its own audit row.

## Reporting and evidence

- Trust Center's `channel` chip (R-82) is the direct evidence trail for "what did the agent actually do" — filterable to `channel=mcp` or `channel=cli`.
- `GET /api/openapi.json` and `GET /llms.txt` are both drift-tested against the live route set (R-21/R-22/R-64) — an agent (or a developer) reading either gets an accurate, current picture, never a stale one.
- Diagram: [`agent-token-lifecycle-flow.html`](../processes/agent-token-lifecycle-flow.html).

## Update 2026-10-17 — journey-audit fixes

- **A token approves with its creator's role (ADR 0014, R-113).** A token carrying an approve scope decides only while the person who minted it is an admin or manager; it stops the moment they are demoted. Agents should read `GET /api/review` and tell a person what is waiting; keep approve scopes off agent tokens unless that is intended.
- **A token dies with its creator's profile.** If the creator's profile is gone or belongs to another workspace, the token answers `401`. Calendar feeds are unaffected (decision 9).
- **Retry-safe creates (R-115).** Project expenses, project tasks and `POST /api/allocations` accept `Idempotency-Key`; the CLI has `--idempotency-key`.
- **Rate limits.** Every `429` sends `Retry-After`. Buckets are per actor id with a workspace ceiling of 5 times; failed bearer authentication is throttled at 20 per minute per client network address before any token lookup.
- **MCP.** The stdio server adds change request, rebaseline propose / sign-off / apply, decision and document tools (`web/mcp/README.md`). The assistant gets none of them.
- **Shared demo login.** It cannot mint tokens or invites (`403` `demo_restricted`).

## Traceability

- R-IDs: R-02 (scoped Bearer PAT auth), R-23 (`nopm` CLI), R-25 (native MCP server, two transports), R-64 (agent tool-registry integrity — one shared registry, lock-tested against Zod), R-70 (least-privilege agent preset).
- Key files: `web/src/app/api/tokens/route.ts`, `web/src/app/api/tokens/[id]/route.ts`, `web/src/lib/auth/scopes.ts`, `web/mcp/server.mjs`, `web/src/app/api/mcp/route.ts`, `web/mcp/tools.mjs`, `cli/lib/api.mjs`, `.mcp.json`.
- Tests: `web/src/lib/auth/scopes.test.ts` (scope registry validation, least-privilege preset shape); `web/src/lib/assistant/tools-zod.test.ts` (tool schemas locked to the API's Zod validators).

## Open questions

- None outstanding for the flow itself.

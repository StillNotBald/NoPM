# Sprint Summary — 2026-11-03_assistant-connector-polish

**TL;DR:** Assistant and connector hardening, audit build-order steps 1-4: shared tool engine, MCP annotations and a safe shared API caller, typed provider errors with a panel banner, and prompt-injection defences for tool results.

## Declared goals
- A13: extract one tool-execution engine (R-182)
- M2/M5/M6/M7 (+ stdio module filter): MCP annotations, shared safe `callApi`, token check on connect (R-183)
- A2: typed provider errors, server log, client banner (R-184)
- A1 step 1: confirm-before-write prompt rule, untrusted tool-result wrapping (R-185)

## Actual outcomes
- Step 1 (R-182): done. `web/src/lib/agent-core/tool-engine.ts` holds `executeToolCall` and `runToolRounds`; both assistant paths use it.
- Step 2 (R-183): done. `web/mcp/shared.mjs` holds `toMcpTool` (annotations), `callApi` (25 s timeout, never throws), `toToolResult` (isError mapping, compact JSON, `next_page`, 60,000 char cap) and `filterToolsByOpenApi`; both servers use them. The remote route checks the token with one `GET /api/me` on `initialize` and `tools/list`.

## Defaults chosen (nobody to ask; industry-standard picks)
- Engine lives in `web/src/lib/agent-core/` (new folder, plain TS, no new dependency); `summarize`, `buildHref` and `buildToolCall` moved there, `index.ts` re-exports the public names so imports and tests are unchanged.
- The engine never mints or revokes tokens; the caller owns the token lifecycle (so a future channel passes its own server-side token).
- Behaviour kept byte-for-byte, including the streaming path's quirk that an empty model reply falls through to a tool-less summary call.
- Annotations are derived from the probed HTTP method (`toRequest({}).method`), as the audit says. Destructive = the four audit-named tools only. Deletion-request tools use the DELETE method but are marked non-destructive (they only raise a request a second person decides).
- `idempotentHint` true for PATCH/PUT only (a repeated POST creates another record).
- Timeout 25 s per REST hop; result cap 60,000 chars; both figures taken from the audit.
- M7: only a definite 401 from `/api/me` blocks the connect; a network failure lets the request through (fail open, so an unrelated outage cannot lock out every client). Stdio only warns on a rejected token, it does not exit.
- M4 for stdio: filter by the server's own `/api/openapi.json` (the audit's cheapest option); fails open to the full list with a stderr warning.
- Error results keep the body's `error`, `code`, `fields`, add `status` and `retry_after_seconds`; network errors use fixed text, never the raw error (it can carry the internal origin).
- Not done from M-findings: M3 (trim descriptions, size budget test) and M9 (docs) are outside this slice.

## R-IDs touched
- R-182 → DONE
- R-183 → DONE

## Files
- `web/src/lib/agent-core/tool-engine.ts`, `web/src/lib/agent-core/tool-engine.test.ts`, `web/src/lib/assistant/index.ts`
- `web/mcp/shared.mjs`, `web/mcp/server.mjs`, `web/src/app/api/mcp/route.ts`, `web/src/lib/assistant/mcp-shared.test.ts`, `web/src/app/api/mcp/connect.test.ts`, `web/src/app/api/mcp/route.test.ts`

## Tests / verification
- `vitest run` on `agent-core`, `assistant/index.test.ts`, `api/assistant/chat/route.test.ts`, `assistant/fallback.test.ts` (65 tests green); `rtm:verify`.

## Follow-ups
- None yet.

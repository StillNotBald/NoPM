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
- Step 3 (R-184): done. `providers/errors.ts` defines `ProviderError`; the provider router normalises every failure; the chat route logs kind/provider/status and returns `provider_error`; the panel shows an alert banner.
- Step 4 (R-185): done. `agent-core/system-prompt.ts` holds the prompt with the confirm-before-write and tool-results-are-data rules; `agent-core/untrusted.ts` wraps every tool result in `<tool_result untrusted="true">` delimiters.

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
- Provider errors are normalised in the router (`providers/index.ts`) as well as at each `!res.ok` site, so timeouts and network errors are typed without editing every fetch call. Status mapping: 401/403 key_invalid, 404 model_not_found, 429 rate_limited, 408/504 timeout, else unavailable. 400 is `unavailable` (the audit lists no kind for it).
- The upstream response body is dropped everywhere (the old messages echoed it, and it can echo request text).
- The grounded read-only fallback is kept (it is useful, and removing it is a product change), but it is no longer silent: logged, flagged in the reply, and bannered. `OpenRouterCapacityError` now extends `ProviderError` (name and `.status` unchanged).
- The banner reuses the existing danger-tinted inline-error pattern in the panel (no new component or token). Fix hint for a bad key points at the existing Disconnect control; no new button. `assistant_credentials.last_error` (audit "optionally") not added: it needs a migration.
- Non-provider failures are logged by error name only, never the message.
- Wrapper escapes every `<` in the JSON as a backslash-u escape (still valid JSON, same value), the cheapest breakout-proof delimiter that needs no parser on the model side. The tool name in the tag is restricted to `[A-Za-z0-9_-]`.
- The confirm rule is a prompt rule only, with the audit's exception wording ("unless the latest message already names every field and says to do it"). All results are wrapped, including server-made error results, for one uniform rule.
- The existing index test that parsed a tool message as raw JSON now unwraps it first; that is the intended behaviour change.
- The server-side confirm gate (`pending_actions`, Confirm/Cancel chips) is step 2 of A1 and was not started (needs a migration).

## R-IDs touched
- R-182 → DONE
- R-183 → DONE
- R-184 → DONE
- R-185 → DONE

## Files
- `web/src/lib/agent-core/tool-engine.ts`, `web/src/lib/agent-core/tool-engine.test.ts`, `web/src/lib/assistant/index.ts`
- `web/src/lib/agent-core/system-prompt.ts`, `web/src/lib/agent-core/untrusted.ts` (+ test)
- `web/src/lib/assistant/providers/errors.ts` (+ test), `providers/index.ts` and the four providers, `web/src/app/api/assistant/chat/route.ts` (+ `provider-error.test.ts`), `web/src/components/assistant/panel.tsx`
- `web/mcp/shared.mjs`, `web/mcp/server.mjs`, `web/src/app/api/mcp/route.ts`, `web/src/lib/assistant/mcp-shared.test.ts`, `web/src/app/api/mcp/connect.test.ts`, `web/src/app/api/mcp/route.test.ts`

## Tests / verification
- Per step, `vitest run --maxWorkers=2` on only the touched files (agent-core, assistant index/fallback/providers, api/assistant, api/mcp, mcp-shared, tools-openapi, tools-mcp-governance): all green. `npx tsc --noEmit` clean. `npm run rtm:verify` green after each commit. The full suite and gen-metrics were not run (lead runs them).

## Follow-ups
- Maintainer/lead: A1 step 2 (server confirm gate, needs a `pending_actions` migration), M1 (OAuth), M3 size budget and M9 docs; none started here.

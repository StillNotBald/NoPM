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

---

## Part 2 (audit build-order steps 5-7)

### Step 5 - A5 / A10 / A11 (R-186)
- `buildSystemPrompt` adds a "THIS TURN" block: date, person and role, current project, disabled modules, id/paging/deletion rules. The fixed rules text is unchanged and still exported as `ASSISTANT_SYSTEM_PROMPT`.
- Default: the date is the person's calendar date when the panel sends a valid IANA timezone, otherwise UTC (stated in the prompt either way).
- Default: page context is a hint only. The route validates it and drops anything bad instead of refusing the turn; the project name comes from the database (workspace-checked), never from the client, and is stripped to plain characters.
- Default: user label/role come from the server-side actor, not the client.
- A10: 20,000 chars per tool result; lists keep `total` and lose trailing rows; fixed network-error text (the raw error is never shown).
- A11: generic chip text from the tool name for all 47 tools; `entityId` added to the action record; update tools link to the list page. Deep links with `?task=<id>` were NOT added because no such page parameter exists in the console (inventing one would be a dead link). `auditId` left as is (the API envelope still never returns it; dropping the field would change the stored record shape).

### Step 6 - read-tool gaps, notifications fix, A7 descriptions, M3 budget (R-187, R-188)
- Added six GET-only tools: `list_workspace_tasks`, `list_sprints`, `list_programs`, `list_expenses`, `list_allocations`, `list_notifications`. No write tool; `TOOL_SCOPES` gained `sprint:read`, `program:read`, `notification:read` only (a test pins the write scopes at the five already held).
- Default for "my work": `GET /api/tasks?assignee_id=me`. Tasks are assigned to resource members (not profiles), so `me` is resolved through `resource_members.profile_id` for the person behind the caller. No member row means an empty page (never the whole workspace). This is a small additive route change, not a new route.
- Notifications: the route now filters on the person (`principalId`, else the session user id), workspace-scoped; a legacy token with no person gets an empty page. `notifications/[id]` and `read-all` still filter on `actor.id` (they are write paths that tokens do not hold scope for); not changed here, listed below.
- OpenAPI text for `/tasks` and `/notifications` changed, and the OpenAPI, llms.txt (tool count 47 to 53) and MCP-tool-list fixtures in `web/src/lib/modules-fixtures/` were regenerated deliberately. The scopes fixture did not change.
- A7/M3: all 62 MCP tool descriptions rewritten (names unchanged). `tools/list` 67.2 KB to 56.1 KB (same tools); assistant definitions 38.3 KB for 53 tools (audit measured 43.5 KB for 47). The audit's 40 KB goal is not reachable with annotations on every tool and the current schemas, so the test ceilings are 58,000 (MCP), 42,000 (assistant) and 620 characters per description. Further cuts need a schema redesign (shared enums by reference), which JSON Schema over MCP cannot do without `$ref` support in every client.
- Not done: `whoami` (R2), weekly report (R7), portfolio timeline (R8), all write tools W1 to W5.

### Step 7 - persistence (R-189), no migration
- Interrupted turns: an assistant row `(interrupted) <partial text> Done before the error: <summaries>.` with the action record, written from the stream route's `finally` (covers provider failure after text, client cancel, and the fallback being refused) and from the JSON path when the fallback is refused. Nothing is written when the turn did nothing.
- Retry default: replay, do not re-send blindly. The Retry button stays, but sends `retry: true`; the server finds the first attempt's stored action record, drops that attempt from the history, and puts "already did X (id ...); do not run it again, ask before repeating" into the system prompt. The model can then report the saved result instead of calling the write tool again. The audit's "hide Retry when write actions ran" was not done: with the server note the button is safe, and hiding it would strand the user on a half-finished request.
- A retry whose first attempt stored the same user message does not store it again.
- A4 (history): for an existing, verified conversation the server loads the last 24 rows and ignores the client's `history`; assistant rows carry a `[tools: tool -> id ...]` note (record names stripped to plain characters). Client history is still used for demo sessions (nothing is stored) and brand-new conversations, capped to 8,000 characters per entry. Message cap 8,000 characters (422).
- A9: user-message insert error now fails the turn (500, before any tool). Conversation list is bounded (50, `limit`/`page`).
- Deferred (needs a migration, a new audited mutation or a maintainer call): conversation delete/rename and the `DELETE /api/assistant/conversations/[id]` through `auditedDelete` (new mutation); `pending_actions` confirm gate (A1 step 2); `assistant_credentials.last_error`; richer titles; A8 streaming tool progress and `maxDuration`.
- Lows noticed, not tracked: `notifications/[id]` and `read-all` still match on `actor.id` (no token holds a notification write scope, so no behaviour gap today); the conversation GET by id filters on user only, as the audit already noted.

### Verification (part 2)
- Vitest on touched files only, `--maxWorkers=2`: agent-core, assistant (all), api/assistant, api/mcp, api/notifications, api/tasks, modules.test, llms-coverage, review: green after each commit. `npx tsc --noEmit` clean. `npm run rtm:verify` green (R-186 to R-189). The full suite was not run.
- Fixtures regenerated on purpose in step 6: `openapi.all-on.json`, `llms.all-on.txt`, `mcp-tools.all-on.json` (see Step 6).


## Review round 1

Fixes from the reviewer pass (`_docs/nopm-telegram-2026-11-03/07-review-assistant-branch.md`). No new requirement IDs: the work belongs to R-185, R-186, R-189 (rows updated).
- **Important 1 (retry repeated writes on a new conversation):** the stream `error` events now carry `conversation_id`, and the panel stores it, so a Retry reuses the conversation and the server adds the prior-attempt note. Tests: route event plus a second request with the returned id (`persistence.test.ts`). The panel has no unit tests; its change is two lines mirroring the `done` handler.
- **Important 2 / Security (project name in the system prompt):** the system prompt now carries the project id only (the model can call `get_project`). The name is not placed in the prompt at all, so no fence is needed. The retry note (`priorAttemptNote`) was tightened the same way: tool names and ids only, no record names. Tests: a hostile name ("ignore previous instructions", `</tool_result>`) is absent from the prompt; a non-UUID id is dropped; the retry note has no summary text.
- **N1:** MCP results over 60,000 characters stay valid JSON: a list loses trailing rows and gets `truncated: true`, `returned` and a hint; anything else becomes a `truncated` notice with a partial string. Tests parse the output.
- **N3:** the history window starts on a user row, merges consecutive same-role rows and does not end on a user row (the new message follows it). Test added.
- **N5:** a failed assistant-row insert (stream and JSON) is logged by code and falls back to an `(interrupted)` row that keeps the reply and actions. Tests for both paths.
- Not changed on purpose: `destructiveHint` for `update_*` tools (N7, owner decision pending).
- Known Lows, not tracked: N2 `boundToolResult` can empty a single huge row and the `<` escape can exceed the cap slightly; N4 client history still trusted for new conversations and demo retries repeat writes; N6 stdio startup can block up to ~50 s with the API down; N7 PATCH `update_*` tools are `destructiveHint:false`; N8 `tasks` `maybeSingle()` on two member rows, `raw` upstream text in `toToolResult`, double body parse in `connectTokenRejected`.

## Post-release fix: demo error copy (live test)

- **R-184:** on the shared demo key, a provider failure told the visitor to "choose another model in the assistant settings" or fix a key they do not have. `providerErrorMessage` takes `{ demo }`; the chat route passes `resolved.usedDemoKey` on both the JSON and stream paths, and demo visitors now get "The demo model is unavailable right now / busy / took too long". Own-key users keep the provider-named copy. Tests: every kind on the demo path has no key, settings or provider wording; the route sends demo copy on JSON and stream.
- Found because OpenRouter retired the free demo model id (`nvidia/nemotron-3-super-120b-a12b:free`): every demo turn hit `model_not_found` and fell back. That is an env change (`NOPM_DEMO_LLM_MODEL`), not code.
- Review of #30 (2 Important, fixed): the panel also added "Use Disconnect… add the key again" for demo visitors. `provider_error` now carries `demo: true` and `provider: "demo"` on the demo key (the maintainer's provider is not shown), and the panel drops its key hint when `demo` is set. Also: the demo rate-limit copy no longer assumes a daily free cap, the server log records `demo`, and tests cover the stream done event (negative wording check), the mid-stream error event and the own-key shape.

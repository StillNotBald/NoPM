# Sprint Summary — 2026-11-03_assistant-connector-polish

**TL;DR:** Assistant and connector hardening, audit build-order steps 1-4: shared tool engine, MCP annotations and a safe shared API caller, typed provider errors with a panel banner, and prompt-injection defences for tool results.

## Declared goals
- A13: extract one tool-execution engine (R-182)
- M2/M5/M6/M7 (+ stdio module filter): MCP annotations, shared safe `callApi`, token check on connect (R-183)
- A2: typed provider errors, server log, client banner (R-184)
- A1 step 1: confirm-before-write prompt rule, untrusted tool-result wrapping (R-185)

## Actual outcomes
- Step 1 (R-182): done. `web/src/lib/agent-core/tool-engine.ts` holds `executeToolCall` and `runToolRounds`; both assistant paths use it.

## Defaults chosen (nobody to ask; industry-standard picks)
- Engine lives in `web/src/lib/agent-core/` (new folder, plain TS, no new dependency); `summarize`, `buildHref` and `buildToolCall` moved there, `index.ts` re-exports the public names so imports and tests are unchanged.
- The engine never mints or revokes tokens; the caller owns the token lifecycle (so a future channel passes its own server-side token).
- Behaviour kept byte-for-byte, including the streaming path's quirk that an empty model reply falls through to a tool-less summary call.

## R-IDs touched
- R-182 → DONE

## Files
- `web/src/lib/agent-core/tool-engine.ts`, `web/src/lib/agent-core/tool-engine.test.ts`, `web/src/lib/assistant/index.ts`

## Tests / verification
- `vitest run` on `agent-core`, `assistant/index.test.ts`, `api/assistant/chat/route.test.ts`, `assistant/fallback.test.ts` (65 tests green); `rtm:verify`.

## Follow-ups
- None yet.

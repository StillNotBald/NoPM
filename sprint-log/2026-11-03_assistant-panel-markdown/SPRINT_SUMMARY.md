# Sprint Summary — 2026-11-03_assistant-panel-markdown

**TL;DR:** The assistant panel now renders model replies as safe markdown (tables, lists, code, bold, links) instead of showing raw `**` and `|` characters.

## Declared goals
- Render assistant replies as markdown in the panel, including tables that scroll sideways (R-204)

## Actual outcomes
- Seen live: the demo model answers with tables and the panel showed them as plain text.
- The document viewer's no-dependency renderer moved to `web/src/lib/markdown/render.tsx` and both surfaces use it. Defaults keep the viewer's output byte-for-byte (checked against the old code before the move); the panel turns on pipe tables and a stricter link rule.
- Security: React elements only, no raw HTML, no `dangerouslySetInnerHTML`. Panel links: http(s) in a new tab and same-origin `/` paths; `javascript:`, `data:`, `mailto:`, `//host` and anything with whitespace or control characters stay as plain text.
- Streaming: an unclosed `**` or backtick stays literal, an open fence shows the code so far, a header row waits for its `|---|` line. Every prefix of a sample reply is tested.
- User messages stay plain text.

## Defaults chosen
- Mailto stays allowed in the document viewer (old behaviour) and is off in the panel (the spec lists http(s) and relative paths only).
- One paragraph per source line, so single line breaks show; blank lines give a small gap.
- Inside the grey bubble, inline code and fences use the canvas colour with a subtle border so they stand out; no new tokens.
- No new dependency.

## R-IDs touched
- R-204 → DONE

## Files
- `web/src/lib/markdown/render.tsx`, `web/src/lib/markdown/render.test.ts`
- `web/src/components/assistant/panel.tsx`, `web/src/components/assistant/panel-markdown.test.ts`
- `web/src/components/documents/document-viewer.tsx`

## Tests / verification
- Renderer unit tests (tables, lists, code, links allowed and blocked, HTML as text, partial markup, viewer parity) and panel tests (table in an assistant reply, user text untouched).
- Gates: `tsc --noEmit`, full `vitest run`, lint, metrics generation and check.

## Follow-ups
- None.

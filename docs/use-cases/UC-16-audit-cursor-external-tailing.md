# UC-16 · Audit cursor for external tailing

**Goal:** Let an external agent (or a scheduled job) tail the audit log forward in time without webhooks or polling infrastructure, and without missing or double-counting rows.

**Actors:** AI agent via token (a scheduled Claude session, a cron-driven script, or any MCP client with `audit:read`).

**Preconditions:** A scoped token with `audit:read` exists.

**Trigger:** Someone wants a running feed of NoPM's activity somewhere else, e.g. posted into a Slack channel, without building a webhook receiver.

## Main flow

1. First poll: `GET /api/audit?since=<iso>&order=asc&limit=100` (scope `audit:read`) — e.g. `since` set to "5 minutes ago" on the very first run.
2. Remember the `created_at` (or `id`, as `after_id`) of the last row seen.
3. Next poll: `GET /api/audit?after_id=<last-seen-id>&order=asc&limit=100` (or continue using `since` with the last row's timestamp) — `after_id` is looked up by `id` AND `workspace_id` first (`404` if it doesn't exist in the caller's workspace, never leaking cross-workspace row existence); its `created_at` becomes a strict `>` lower bound. `since` and `after_id` may be combined; Postgrest ANDs both comparators, so the more restrictive one wins.
4. MCP: the `query_audit` tool carries optional `channel`/`since`/`order` properties for the same purpose. CLI: `nopm audit --since <iso> --after-id <id> --order asc` (prints a `channel` column).
5. Optional: filter to one surface with `?channel=cli` (or `mcp`/`assistant`/`ui`/`api`) to watch only agent-driven writes, for example.
6. Recipe documented in `web/mcp/README.md`: attach both the NoPM MCP server and a Slack MCP server to one Claude session (or a scheduled/cron-driven agent via the `/schedule` or `/loop` workflow), and every N minutes ask it to call `query_audit` with the last-seen cursor, posting new rows into a channel.

## Alternate and exception flows

- **`since` unparsable** → `422`.
- **`after_id` doesn't exist in the caller's workspace** → `404`.
- **`order` not `asc`/`desc`** → `422`.
- **`GET /api/export?entity=audit`** supports `since`/`order` too (consistently applied, a bad value just fails to narrow/reorder rather than failing the whole download) but does **not** support `after_id` — that requires the row-lookup only the list route performs.
- **Missing `audit:read`** → `403`.

## Postconditions

- Reading does not write anything, except that `GET /api/export?entity=audit` (if used instead of the list endpoint) itself writes an `export.csv` audit row (UC-14) — tailing via the plain `GET /api/audit` list endpoint does not.

## Reporting and evidence

- `request_id` (from `X-Request-Id`, echoed back as a response header) lets a caller correlate every write from one agent turn under one id — useful when tailing a multi-step agent operation, since every audit row it produced can be grouped by that id.
- `channel` on every row states which surface wrote it (`ui|api|cli|mcp|assistant`) — provenance only, never an authorization input.

## Traceability

- R-IDs: R-85 (audit cursor: since/after_id/order + channel on every audit surface), R-82 (audit provenance: channel + request id).
- Key files: `web/src/app/api/audit/route.ts`, `web/src/app/api/audit/_query.ts` (`parseAuditFilters`), `web/mcp/tools.mjs` (`query_audit`), `cli/commands/audit.mjs`, `web/mcp/README.md` ("Recipe: tail the audit log into Slack").
- Tests: `[UNVERIFIED exact test file]` for the cursor pagination edge cases; behavior described directly in `requirements/REQUIREMENTS.md` R-85 and `web/src/app/llms.txt/route.ts`.

## Open questions

None outstanding; this flow is documented almost verbatim in `web/mcp/README.md`'s own recipe section and `llms.txt`.

# UC-14 · Export and board-pack reporting

**Goal:** Get data out of NoPM in a form a stakeholder meeting or a spreadsheet can consume, with minimal effort and without breaking governance (exports are themselves audited).

**Actors:** Finance / PMO, Project Manager. AI agent via token with the matching `<entity>:read` scope, or `audit:read` for the deck.

**Preconditions:** Data exists in at least one of the exportable registers.

**Trigger:** A stakeholder needs a CSV for further analysis, or a board-pack-style deck for a review meeting.

## Main flow — CSV export

1. `GET /api/export?entity=<entity>` (scope `<entity>:read`), `entity` required, one of `tasks|risks|issues|clashes|audit|programs`. Each entity reuses the **same** filter/sort parser as its own list API, so export can never drift from what the list endpoint returns (tasks: `project_id/assignee_id/status_type/priority/due_before/due_after/overdue/q/sort`; risks/issues: `project_id` required + `status/severity(/priority)/sort`; clashes: none; audit: `target_type/target_id/action/actor_id/channel/since/order` — lenient, bad values dropped not `422`, `after_id` not supported here; programs: none, fixed name-ascending).
2. Response streams `text/csv`, filename `nopm-<entity>-<date>.csv` (server-derived date), capped at 10,000 rows (truncation noted in a final CSV row plus a server log entry).
3. The CSV writer neutralizes formula injection (CWE-1236) on every cell, not just audit exports.
4. Exporting is itself audited: one `export.csv` audit row per export, `target_type=<entity>`, including `entity=audit` — exporting the audit log is itself an audited action.

## Main flow — deck export (board-pack)

1. `GET /reports/deck` or `POST /reports/deck` (scope `audit:read`), `?format=pptx|pdf|html` — a portfolio-wide deck, data-driven and server-rendered.
2. `GET /reports/project/{id}` or `POST /reports/project/{id}` (same scope, same format options) — a single-project report.
3. UI: deck export is reachable from the console (exact page `[UNVERIFIED]`) using `pptxgenjs`/`jspdf`/`html2canvas` per the constitution's approved-libs list.

## Alternate and exception flows

- **`entity` omitted or unrecognized on `GET /api/export`** → `422`/`400` `[UNVERIFIED exact status]`.
- **Missing the matching `<entity>:read` (or `audit:read` for the deck)** → `403`.
- **Export exceeds 10,000 rows** → not an error; the CSV is truncated with a final row noting it, and the server logs the truncation.
- **`GET /audit`'s stricter `since`/`order` validation vs. export's lenient handling** — a documented, deliberate asymmetry: the interactive/agent-facing `GET /audit` `422`s on a bad `since`/`order` value; the export CSV silently drops a bad value instead of failing the whole download.

## Postconditions

- One `export.csv` audit row per export call, workspace-scoped, visible in the Trust Center like any other write.
- No underlying data is modified by an export.

## Reporting and evidence

- This use case **is** the reporting evidence path for every other register in the catalogue; the CSV export reuses each entity's real filter/sort contract, so a report can be reproduced by re-running the same query the console page used.
- The deck export is the presentation-ready counterpart for a stakeholder meeting, generated server-side so the numbers match the live data (`web/scripts/gen-metrics.mjs` generates the case-study's own proof metrics the same way, so numbers are never hand-typed).

## Traceability

- R-IDs: R-40 (Deck export PPTX/PDF/HTML), R-68 (Governed CSV export, L-27/L-36).
- Key files: `web/src/app/api/export/route.ts`, `web/src/lib/export/csv.ts`, `web/src/app/api/reports/deck/route.ts`, `web/src/app/api/reports/project/[id]/route.ts`, `web/src/components/export-csv-button.tsx`.
- Tests: `[UNVERIFIED exact test file]` for the CSV formula-injection neutralization; referenced by description in R-68 but not read directly.

## Open questions

- `[UNVERIFIED]` Exact status code/behavior when `entity` is omitted or unrecognized on `GET /api/export`.
- `[UNVERIFIED]` The exact console page/button that triggers a deck export.
- `[UNVERIFIED]` Whether `resources`/`allocations`/`change_requests`/`documents` have their own export entity value (not found in the documented list).

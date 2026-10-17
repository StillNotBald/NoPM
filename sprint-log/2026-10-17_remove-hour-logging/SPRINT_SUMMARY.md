# Sprint Summary — 2026-10-17_remove-hour-logging

**TL;DR:** Hour logging and weekly timesheets removed from the product (owner decision 18); data kept; budget actual is now expenses only.

## Declared goals
- Remove time logging and timesheets (log, submit, approve, reject, reopen, week lock) from console, API, CLI, MCP, assistant, Lark and docs.
- Keep the database tables and rows; no migration; reversible by git revert.
- Budget actual, EVM actual cost and every rollup that used hours now use expenses only.

## Actual outcomes
Delivered as a five-worker wave on branch `feat/remove-hour-logging`. Docs worker (H5): OpenAPI and llms.txt trimmed, requirements and traceability updated, use cases and guides edited, CUTOVER/09 written, journey map work.yaml purged of the time_entry and timesheet entities.

## R-IDs touched
- R-17, R-74, R-76, R-114 → WITHDRAWN (2026-10-17, owner decision 18)
- R-115 → DONE, now covers expenses, tasks and allocations only
- R-77, R-95, R-103, R-111, R-113 → DONE, timesheet clauses retired

## Files
- `web/src/app/api/openapi.json/route.ts`, `web/src/app/llms.txt/route.ts`, `requirements/*`, `docs/**`, `user-manual/**`, `CUTOVER/09-REMOVE-HOUR-LOGGING.md`, `journeys/parts/work.yaml`

## Tests / verification
- `npm run rtm:verify`, openapi-coverage and llms-coverage tests, journey-kit validate.

## Follow-ups
- Decide later whether to drop the retained tables (needs its own owner decision and a migration).

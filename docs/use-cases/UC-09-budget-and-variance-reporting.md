# UC-09 · Budget tracking and variance reporting

**Goal:** Track planned, committed, and actual cost for a project (actual = expenses only), and see variance and burn against plan without a spreadsheet.

**Actors:** Finance / PMO, Project Manager. AI agent via token with `budget:read`/`budget:write` (read-only in the MCP tool catalogue — `get_budget` only, no write tool shipped).

**Preconditions:** A project exists. Actuals come from recorded expenses only. Hour logging was removed on 2026-10-17 (owner decision 18), so there is no labor cost from hours x cost-rate.

**Trigger:** A stakeholder needs to know whether a project is on budget, or PMO needs a portfolio-wide cost picture.

## Main flow

1. Set or update the budget envelope: `PUT /api/projects/{id}/budget` (scope `budget:write`; `PATCH` is an alias for the same operation) with `planned_amount`, `committed_amount`, `currency`.
2. Record project expenses: `POST /api/projects/{id}/expenses` (scope `budget:write`).
3. Actual cost is the sum of the project's expenses (no hours x cost-rate labor; UI label "Actual (expenses)").
4. Read the rolled-up summary: `GET /api/projects/{id}/budget` (scope `budget:read`) returns `planned`, `committed`, `actual` (expenses only), `variance`, `burn_pct`.
5. MCP: `get_budget` tool, scope `budget:read` — read-only; there is no MCP write tool for budget, so an agent can report on budget but not set it.

## Alternate and exception flows

- **Missing `budget:write` on a set/expense write, or `budget:read` on the summary read** → `403`.
- **Invalid `currency`** → not a 3-letter ISO code → `422` (consistent with the project's own currency-field validation rule).
- **Delete an expense** → `DELETE /api/expenses/{id}` (scope `budget:write`).

## Postconditions

- `budget.upsert` (or equivalent) audit row on `PUT`/`PATCH`; `expense.create`/`expense.delete` rows per expense write.
- The project's budget summary reflects the change immediately — no separate reconciliation job.

## Reporting and evidence

- Program rollup cards (UC-01, R-71) show budget variance and actual-vs-planned cost per program, aggregating the child projects' budget summaries.
- No `entity=budget` value is documented on `GET /api/export`'s entity list `[UNVERIFIED]` — board-pack export of budget figures likely goes through the deck export (UC-14) rather than a raw CSV.
- Deck export (`GET /reports/deck`, `GET /reports/project/{id}`, scope `audit:read`, `?format=pptx|pdf|html`) includes budget figures as part of the portfolio/project report (R-40).

## Update 2026-10-18 - common-pattern answers

- Overspend warning (decision 19): `GET /api/projects/{id}/budget` returns `overspend { level, warn_pct, over_pct, events[] }`. Level is `ok`, `warn` (default 90% of plan) or `over` (100%). `overspend_warn_pct` (1 to 100) can be set on PUT/PATCH. One `budget.overspend` audit row is written per level change. Overspend never blocks anything.
- Budget change on a locked project (decision 23): once the project dates are locked, a budget PUT/PATCH needs `change_request_id` of an approved change request (422 `change_request_required`, `change_request_invalid`, `change_request_not_approved`). Expenses stay audit-only.

Source: owner decisions 19 to 25 and the rule "follow the common pattern" (`journeys/COMMON-PATTERN-ANSWERS.md`, ADR 0015, requirements R-120 to R-126).

## Traceability

- R-IDs: R-18 (Budget — planned/committed/actual/variance/burn).
- Key files: `web/src/app/api/projects/[id]/budget/route.ts`, `web/src/app/api/projects/[id]/expenses/route.ts`, `web/src/app/api/expenses/[id]/route.ts`, `web/src/lib/insight/program-rollup.ts`.
- Tests: EVM math (both SPI modes + divide-by-zero) is covered under R-60's governance-invariant vitest suite.

## Open questions

- `[UNVERIFIED]` Whether `GET /api/export` has any budget-specific entity value; not found in the documented entity list.
- `[UNVERIFIED]` The exact EVM (earned value management) formulas behind "burn_pct" and "variance" were not read from source in this pass; only their existence and test coverage (R-60) were confirmed.

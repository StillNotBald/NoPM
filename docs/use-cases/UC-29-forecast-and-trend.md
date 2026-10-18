# UC-29 · Forecast at completion and project trend

**Goal:** Give finance and the project manager two forecasts of the final cost, and a suggested RAG status that comes from the trend. The forecast uses what is spent, what is committed, and what is still to be spent. The trend uses daily snapshots of schedule and cost health. The suggestion is advice only: it never changes the declared RAG status.

**Actors:** Finance or PMO, with budget write access, for the forecast. Project manager, with project read access, for the trend. Anyone with the budget or project read scope can see the figures.

**Preconditions:** Migrations 0097 (forecast columns) and 0098 (`project_snapshots`) are applied before the build serves traffic. The nightly snapshot cron is running. A trend starts the morning after the first snapshot and reads "low confidence" until three snapshots exist.

**Trigger:** A monthly or board-pack review needs a forecast beyond the classic budget-over-CPI figure. Or a project's health needs a second opinion from its own history.

## Main flow

1. Open the **Budget** page and select the project.
2. In the **Forecast and trend** card, enter the estimate to complete: the amount still to be spent beyond what is committed. Leave it empty if nobody has estimated it.
3. Choose the forecast method: `cpi` (the default, budget over CPI) or `bottom_up` (spent plus committed plus the estimate). The method decides which forecast is reported as EAC.
4. Read both forecasts. The EVM table names the method beside EAC. The card stacks at phone width.
5. Read the **Suggested RAG** beside the declared RAG, with its reason, for example "SPI 0.86 falling over 3 weeks". The line under it reads "Advice only; the declared RAG is yours to set".
6. Change the declared RAG yourself if you agree. Nothing in the build writes the declared RAG from the suggestion.
7. Export the budget CSV. It has three trailing columns: EAC (CPI), EAC (bottom-up) and forecast method.

## Alternate and exception flows

- **The chosen method cannot be computed** → EAC is null. The other forecast is not used in its place. CPI is null until money is spent. The bottom-up forecast is null until an estimate exists.
- **Fewer than three snapshots** → the trend reads low confidence, and the suggestion says so.
- **The project is complete, or has no snapshots** → no suggested RAG is given.
- **Estimate or method change on a locked project** → allowed without a change request, because these move the forecast, not the approved plan. Any other budget field still needs an approved change request.
- **Estimate below zero, or a method other than the two above** → `422`.

## Postconditions

- Saving the estimate or the method writes one `budget.update` audit row, with both columns in before and after.
- The nightly cron writes one `snapshot.taken` audit row per workspace per run, with the counts.
- Reading the trend writes no audit row, and nothing is stored for it.

## Evidence produced

- The budget row with `estimate_to_complete` and `forecast_method`.
- The `budget.update` and `snapshot.taken` audit rows.
- The daily `project_snapshots` rows, one per project per workspace day.

## API calls

- `PATCH /api/projects/{id}/budget` and `PUT /api/projects/{id}/budget` accept `estimate_to_complete` (number or null) and `forecast_method` (`cpi` or `bottom_up`) (scope `budget:write`).
- `GET /api/projects/{id}/budget` returns the `forecast` object: method, estimate to complete, committed, EAC, EAC (CPI), EAC (bottom-up), ETC and VAC.
- `GET /api/projects/{id}/evm` and the MCP `get_evm` tool carry the same fields (scope `budget:read`).
- `GET /api/projects/{id}/trend?n=28` returns the series, the trend, the suggestion, its reason and the thresholds (scope `project:read`).
- `GET /api/cron/snapshots` is the nightly tick, under `CRON_SECRET`, and is not for users or tokens.

## Reporting and evidence

- Committed is never double counted. Spent is expenses only. Committed is a separate figure. The estimate is only what comes after committed.
- The trend rules are in words: RED when the slip is over 10 days, or CPI or SPI is under 0.90 on each of the last three snapshots. AMBER when the slip is over 3 days, an index is under 0.95, the slip grows by more than a day a week while slipping, or an index is falling and still under 1.00. GREEN otherwise.
- The thresholds are exported constants and are returned with each trend response.

## Traceability

- R-IDs: R-144 (forecast at completion, audit gap B3), R-145 (snapshots, slip trend and suggested RAG, audit gap B6).
- Key files: `web/supabase/migrations/20261018000097_budget_etc.sql`, `web/supabase/migrations/20261018000098_project_snapshots.sql`, `web/src/lib/evm.ts`, `web/src/lib/insight/trend.ts`, `web/src/lib/insight/snapshots.ts`, `web/src/app/api/cron/snapshots/route.ts`, `web/src/app/api/projects/[id]/trend/route.ts`, `web/src/components/budget/forecast-panel.tsx`.

## Open questions

- The bottom-up forecast depends on the estimate the person enters. The build does not check that the estimate is reasonable.

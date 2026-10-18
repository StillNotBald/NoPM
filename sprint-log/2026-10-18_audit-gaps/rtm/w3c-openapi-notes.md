# W3-C OpenAPI / llms.txt notes (for the docs agent)

## New routes

### `GET /api/projects/{id}/trend` (B6)
- Scope `project:read`. Workspace-filtered; 404 for a project outside the workspace. Read-only and derived: nothing is written or audited.
- Query: `n` (integer, default 28, 1 to 120): how many of the latest daily snapshots to use.
- Response `{ data }`:
  - `project_id`, `declared_rag` (the project's own rag_status: not_started, red, amber, green, complete)
  - `suggested_rag`: `green | amber | red | null` (null with no snapshots, or when the project is 100% complete)
  - `reason`: short text, for example `SPI 0.92 falling over 3 weeks`, `12 days past plan, growing 2.5 days a week`, `On plan`, `No snapshots yet`
  - `confidence`: `low` (fewer than 3 snapshots) or `ok`
  - `trend`: `{ snapshots, from, to, slip_per_week, latest_slip_days, spi: { latest, direction (rising|falling|flat|unknown), falling_days }, cpi: { same }, suggested_rag, confidence, reason }`
  - `thresholds`: the constants the rules use (`redSlipDays` 10, `redIndex` 0.9, `redRun` 3, `amberSlipDays` 3, `amberIndex` 0.95, `slipGrowthPerWeek` 1, `indexEpsilon` 0.02)
  - `series`: oldest first, each `{ taken_at, spi, cpi, eac, planned_end, forecast_end, slip_days, completion_pct, open_risks_high, rag_declared, rag_suggested }`
- Rules, in words: RED when slip is more than 10 days, or CPI or SPI is below 0.90 on each of the last 3 snapshots. AMBER when slip is more than 3 days, or the latest CPI or SPI is below 0.95, or slip grows by more than 1 day a week while slipping, or an index is falling (more than 0.02 below a week ago) and still under 1.00. GREEN otherwise. The suggestion never changes the declared RAG.

### `GET /api/cron/snapshots` (B6, the nightly tick; not for users or tokens)
- `auth: false`. The only credential is `Authorization: Bearer $CRON_SECRET` (same check as `/api/integrations/cron`); 401 otherwise, including when CRON_SECRET is unset.
- Vercel Cron `37 17 * * *` (17:37 UTC = 01:37 in the default Kuala Lumpur zone). `maxDuration` 60.
- Takes one `project_snapshots` row per project for the workspace's current day. Idempotent: a second call the same day inserts nothing. Writes ONE `snapshot.taken` audit row per workspace per run, `after` = `{ taken_at, projects, taken, already_taken }`.
- Response `{ data: { workspaces, projects, taken, skipped } }`.
- Should be marked internal in the spec, like the integrations cron.

## Changed routes

### `PATCH /api/projects/{id}/budget`, `PUT /api/projects/{id}/budget` (B3)
New optional body fields (also in the `upsertBudgetSchema` zod body):
- `estimate_to_complete`: number, zero or more, or `null` to clear. The to-finish spend still to come BEYOND what is committed.
- `forecast_method`: `cpi` (default) or `bottom_up`. Which forecast is reported as `eac`.
- On a locked project these two fields, like `overspend_warn_pct`, need NO change request (they move the forecast, not the approved plan). Any other budget field still needs `change_request_id`.
- Audited by the existing `budget.update` row (before/after carry both columns).

### `GET /api/projects/{id}/budget` (B3)
Response gains `estimate_to_complete`, `forecast_method` (on the row) and a `forecast` object:
`{ method, estimate_to_complete, committed, eac, eac_cpi, eac_bottom_up, etc, vac }`.
- `eac_cpi` = budget / CPI (null until money is spent). `eac_bottom_up` = spent (expenses only) + committed + estimate_to_complete (null while no estimate exists). `eac` follows `method` and is null when that method cannot be computed (no silent fallback). `etc` = eac minus spent. `vac` = budget minus eac.
- Committed is never double counted: spent is expenses only, committed is separate, the estimate is only what comes after committed.

### `GET /api/projects/{id}/evm` (B3, wave 2 route)
Response gains `eac_cpi`, `eac_bottom_up`, `forecast_method`, `estimate_to_complete`; `eac`, `etc`, `vac` follow the method. (Route only reads two more budget columns.)

### `GET /api/review` (G5)
- New query `mine` (`1` or `true`): only requests assigned to the person behind the caller (a token counts as its creator). A caller with no resolvable person gets an empty list. `total` and paging reflect the filter.
- Each item gains `assigned_approver_id` (uuid or null) and `assigned_to_me` (boolean). Assignment is routing only; it never changes `can_decide`.

### Raise endpoints (G5): new optional body field `assigned_approver_id` (uuid or null)
- `POST /api/projects/{id}/change-requests`
- `POST /api/projects/{id}/rebaselines`
- `DELETE /api/tasks/{id}` (the maker step; body `{ reason, assigned_approver_id? }`)
- `DELETE /api/projects/{id}` (the maker step; body `{ reason, assigned_approver_id? }`)
- Must be an admin or manager of the caller's workspace and not the requester, else 422 `invalid_assigned_approver` with `fields[0].field = assigned_approver_id`. A person from another workspace and a person who does not exist read the same. Nothing is assigned automatically.
- Audit: the change-request and rebaseline create rows carry it in `after` (the stored row); the task and project delete-request rows carry `{ assigned_approver_id }` in `after` (null when unassigned).
- Schemas gaining the field: `createChangeRequestSchema`, `createRebaselineSchema`, `TaskDeleteRequestSchema`, `ProjectDeleteRequestSchema` (all already feed the spec through `zodBody`).

## Schemas / glossary
- Budget schema gains `estimate_to_complete` (number, nullable) and `forecast_method` (enum cpi, bottom_up).
- Change request, DeletionRequest, Rebaseline schemas gain `assigned_approver_id` (uuid, nullable).
- New audit action `snapshot.taken` (already in `action-glossary.ts`).
- Budget CSV export on the Budget page gains three trailing columns: `EAC (CPI)`, `EAC (bottom-up)`, `Forecast method`.

## llms.txt
Add a line for the trend route, the `mine` filter, and the two budget forecast fields. Add the snapshot cron to the same internal list as the integrations cron.

## Fix pass additions (F5, F20)
- `PATCH`/`PUT /api/projects/{id}/budget`: new optional `committed_open` (number, zero or more, or null). Commitments not yet invoiced; null means "use committed_amount". Advisory like the other forecast fields (no change request on a locked project). Bottom-up EAC = spent (expenses) + committed_open (else committed) + estimate_to_complete.
- `GET /api/projects/{id}/budget` `forecast` object and `GET /api/projects/{id}/evm` gain `committed_open` (the figure the bottom-up forecast used).
- `GET /api/projects/{id}/evm`: a failed budget or expenses read is now a 500, not zeros.

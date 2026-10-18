# UC-07 · Resource capacity and allocation

**Goal:** Model who is available, at what cost rate and capacity, and allocate them against projects/tasks so workload and cost roll up correctly across the portfolio.

**Actors:** Resource owner / Project Manager, Finance/PMO (reads cost-rate data). AI agent via token with `resource:read`/`resource:write`.

**Preconditions:** A workspace exists.

**Trigger:** Onboarding a person into the delivery model, or assigning existing people's time against a project or task.

## Main flow

1. Create a resource member: `POST /api/resources` (scope `resource:write`) — a person record carrying cost rate and capacity. UI: Resources page "Add member" (R-47).
2. Allocate the person to a project or task: `POST /api/allocations` (scope `resource:write`) with `member_id`, optional `project_id`/`task_id`, `allocation_pct` (0-500) or `hours`, and a `window_start`/`window_end`. This is also the write path that can trigger UC-06's clash detection.
3. `resource_members.profile_id` bridges a login identity to this same person record (R-44, "unified person identity") — so task assignment (`tasks.assignee_id → resource_members`), capacity/allocation, and cost are all one identity, not three that can drift apart. This is what makes My Work/My Tasks resolve "my" tasks and lets the Resources view show each person's open-task load beside capacity and cost in one row.
4. UI: Resources page renders an allocated-vs-capacity workload chart with a week/month period selector (`WorkloadChart`, R-68, `web/src/components/resources/workload-chart.tsx`).

## Alternate and exception flows

- **Missing `resource:write`** → `403`.
- **Allocation exceeds capacity** → does not block the write; it is exactly the trigger for UC-06's automatic clash detection, not a hard validation failure.
- **Update/delete a resource or allocation** → `PATCH`/`DELETE /api/resources/{id}` and `PATCH`/`DELETE /api/allocations/{id}` (both scope `resource:write`); updating an allocation re-runs clash detection.

## Postconditions

- `resource.create`/`resource.update`/`resource.delete` and `allocation.create`/`allocation.update`/`allocation.delete` audit rows, one per write.
- The Resources view's open-task column and the workload chart reflect the new allocation immediately (no separate rollup job).

## Reporting and evidence

- `GET /api/resources` and `GET /api/allocations` (scope `resource:read`), paginated.
- No dedicated `entity=resources`/`entity=allocations` value is documented in the `GET /api/export` endpoint list `[UNVERIFIED]` — the documented export entities are `tasks|risks|issues|clashes|audit|time_entries|programs` only, so resource/allocation export may require reading the list endpoints directly rather than the governed CSV path.
- The workload chart and each person's open-task count are the primary "presentable multi-project" reporting surfaces here — a manager can see one person's load across every project they're allocated to.

## Traceability

- R-IDs: R-16 (Resource members + allocation), R-44 (Unified person identity), R-68 (workload chart, O1 operational surfaces).
- Key files: `web/src/app/api/resources/route.ts`, `web/src/app/api/allocations/route.ts`, `web/src/components/resources/workload-chart.tsx`, migration `0019` (unified person identity bridge).
- Tests: `[UNVERIFIED]` no resource-specific test file was read directly in this pass.

## Open questions

- `[UNVERIFIED]` Whether `GET /api/export` supports `entity=resources` or `entity=allocations`; the documented entity list in `llms.txt` names only tasks/risks/issues/clashes/audit/time_entries/programs.

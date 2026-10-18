# UC-03 · Kanban move as a governed status change

**Goal:** Move a task through its lifecycle on the board, and have that action produce the same immutable audit record as any other governed write.

**Actors:** Team member. AI agent via token with `task:write` (the governed Kanban move is agent-reachable per R-64).

**Preconditions:** The task's project exists and is not locked (drag is disabled entirely on a locked project's board).

**Trigger:** A team member finishes work on a task, or otherwise needs to reflect its real-world status.

## Main flow

1. UI: `/projects/[id]` → Board tab, a five-column Kanban (`Backlog → To do → In progress → Done → Canceled`) built on `dnd-kit` (`web/src/components/kanban/board.tsx`).
2. Dragging a card to another column issues `PATCH /api/tasks/{id}` changing `status_type` (scope `task:write`) — the exact same governed write path as editing the field by hand in the detail panel.
3. Agent equivalent: MCP `update_task` tool (documented explicitly as "the governed Kanban move") or `PATCH /api/tasks/{id}` directly, or `nopm tasks update <taskId> --status-type completed`.
4. The write produces one `task.update` audit row with the before/after `status_type`, visible immediately in the Trust Center.

## Alternate and exception flows

- **Project is locked** → cards are not draggable in the UI (`useSortable({ disabled: isLocked })`); status changes are explicitly **not** blocked by a lock even when attempted via the API directly — lock only freezes schedule-shape fields (start/due dates, estimate, milestone/project assignment), never `status_type`, `completion_pct`, checklist, assignee, priority, name, description, or labels.
- **Missing `task:write` scope** → `403`.
- **Viewer session** → drag is not offered in the UI, and a direct API call is rejected `403`.
- **Invalid `status_type`** → `422` (must be one of `backlog|unstarted|started|completed|canceled`).

## Postconditions

- Exactly one `task.update` audit row per drag, carrying the full before/after task state, not just the changed field.
- Trust Center color-codes the `task.update` action and links it back to the task via "History".

## Reporting and evidence

- Status-aging (R-68, `lib/insight/status-age.ts`) derives "days in current status" from the `audit_log` history of `task.update` transitions, rendered as a column and rollup on the project task table — this is a direct downstream reporting consumer of the same audit rows this use case writes.
- Sprint flow metrics (R-73) — burndown and velocity charts, and time-in-status (`GET /api/metrics/time-in-status`) — are pure functions over these same `task.update` audit transitions; no separate status-history table exists.

## Update 2026-10-18 - common-pattern answers

- A status drag no longer voids a pending task-deletion request. Only a change to the task's title, dates or assignee does (`tasks.content_updated_at`).
- Unknown fields in a task create or update are refused 422: `Unknown field "x". Nothing was saved.`
- Finished work can still be reopened freely; the audit row records it.

Source: owner decisions 19 to 25 and the rule "follow the common pattern" (`journeys/COMMON-PATTERN-ANSWERS.md`, ADR 0015, requirements R-120 to R-126).

## Traceability

- R-IDs: R-32 (Kanban, drag = audited status change), R-01 (immutable audit log), R-64 (agent-reachable governed Kanban move).
- Key files: `web/src/components/kanban/board.tsx`, `web/src/app/api/tasks/[id]/route.ts`, `web/src/lib/audit/write.ts`, `web/src/lib/insight/status-age.ts`, `web/src/lib/insight/burndown.ts`.
- Tests: audit-coverage invariant test (`web/src/lib/audit/coverage.test.ts`, R-83) asserts every mutating route, including this one, calls `writeAudit`.

## Open questions

None outstanding; this flow is directly documented in `user-manual/operator/02-projects-and-tasks.md` and the code matches.

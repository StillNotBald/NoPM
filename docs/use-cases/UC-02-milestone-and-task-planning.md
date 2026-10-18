# UC-02 · Milestone and task planning with dependencies

**Goal:** Break a project down into milestones and tasks, and express ordering constraints between tasks so the Gantt view and critical-path analysis reflect real delivery sequencing.

**Actors:** Project Manager, Team member. AI agent via token with `milestone:write` / `task:write`.

**Preconditions:** A project already exists (UC-01). The project is not locked, or the write being attempted does not touch schedule-shape fields (see Alternate flows).

**Trigger:** A Project Manager needs to plan out the work for a project.

## Main flow

1. Create a milestone. UI: within a project's Board/Gantt context (exact button location `[UNVERIFIED]` beyond the schema); API: `POST /api/projects/{id}/milestones` (scope `milestone:write`). Required: `name`. `status` one of `not_started|on_track|at_risk|delayed|completed`; `target_date` must be full ISO 8601 with offset (e.g. `2026-09-30T00:00:00Z`); `start_date` is `YYYY-MM-DD`.
2. Create a task under the project. UI: `/projects/[id]` → Board tab → "New Task", posting to `POST /api/projects/{id}/tasks` (scope `task:write`). Fields exposed in the form (`web/src/components/forms/task-form.tsx`): Name, Status, Priority, Milestone, Completion %, Start Date, Due Date, Estimate (hours), Story Points, Assignee, Labels, Description, "Blocked by" (dependency picker), Acceptance Criteria, Checklist.
3. CLI: `nopm tasks create --project <id> --name "Cutover dry-run" [--priority high] [--status-type started] [--milestone <id>] [--due 2025-06-30]`.
4. MCP: `create_task` tool, scope `task:write`.
5. Add a dependency between two tasks: `POST /api/tasks/{id}/dependencies` (scope `task:write`) with `predecessor_id`, `type` (`FS`|`SS`|`FF`|`SF`, default `FS`), `lag_days` (integer, default 0, negative values are lead time). UI surfaces this as the task's "Blocked by" field.
6. The Gantt tab on the project detail page renders tasks as bars against `start_date`/`due_date`, colored by `status_type`, with dependency arrows drawn between them (`user-manual/operator/03-schedule-and-lock.md`). It is read-mostly: the schedule shape changes through task/milestone edits and the lock/rebaseline flow (UC-11), not by dragging bars.

## Alternate and exception flows

- **Task or milestone created on a locked project** → `422` `project_locked`. Task/milestone **create** is one of the operations blocked under lock (R-65), along with dependency add/remove and any PATCH touching `start_date`, `due_date`, `baseline_start_date`, `baseline_due_date`, `estimate_hours`, `milestone_id`, or `project_id`. The response tells the caller to ask an admin to unlock or propose a rebaseline; the blocked attempt still writes a fail-soft `task.create.blocked` (or equivalent) audit row.
- **Milestone `target_date` sent as a bare date instead of full ISO 8601 with offset** → `422` validation error.
- **Missing scope** → `403`.
- **Removing a dependency** → `DELETE /api/tasks/{id}/dependencies` with `predecessor_id` in the body; same lock rule applies.

## Postconditions

- One `task.create` (and one `milestone.create` where applicable) audit row per write, `before: null`.
- Dependency add/remove writes its own audit row against the task.
- The task appears in `GET /api/tasks` (cross-project list, R-68) and `GET /api/projects/{id}/tasks`, and on the project's Board/Gantt tabs.
- Trust Center shows every create with a "History" deep-link from the task detail panel.

## Reporting and evidence

- Cross-project task register at `/tasks` (sidebar: Tasks) with filter/sort/export (R-68): `GET /api/tasks` supports `project_id`, `assignee_id`, `status_type`, `priority`, `due_before`, `due_after`, `overdue`, `q`, `source`, `external_ref`, and `?sort=field:asc|desc` over `due_date|priority|status_type|name|created_at|completion_pct`.
- `GET /api/export?entity=tasks` reuses the identical filter/sort parser, so an export can never drift from the list API's behavior.
- The Portfolio roadmap (`/portfolio` swim-lane view, R-42) plots every project's milestones on one shared timeline with RAG-tinted bars and baseline-slip markers.

## Update 2026-10-18 - common-pattern answers

- Completing a milestone that still has open tasks is refused with 422 `open_tasks` ("3 tasks are still open. Complete this milestone anyway?"). Resend with `confirm_open_tasks: true` to complete it anyway.
- Moving a milestone's `rag_status` away from complete is for managers and admins only.
- Closing a sprint that has unfinished tasks needs `move_unfinished_to` (`backlog` or another sprint id): 422 `unfinished_tasks` or `invalid_destination` otherwise. A task added after the sprint started is marked `scope_added` in the audit row. A sprint past its start date without being started, or past its end date without being closed, is flagged by `timing_flag` (`late_to_start`, `past_end`); nothing starts or closes automatically.
- A body field the endpoint does not know is refused 422: `Unknown field "x". Nothing was saved.`

Source: owner decisions 19 to 25 and the rule "follow the common pattern" (`journeys/COMMON-PATTERN-ANSWERS.md`, ADR 0015, requirements R-120 to R-126).

## Traceability

- R-IDs: R-11 (Milestones CRUD), R-12 (Tasks CRUD + typed statuses), R-33 (Gantt + baselines), R-65 (project-lock enforcement), R-68 (cross-project task register).
- Key files: `web/src/app/api/projects/[id]/milestones/route.ts`, `web/src/app/api/projects/[id]/tasks/route.ts`, `web/src/app/api/tasks/[id]/dependencies/route.ts`, `web/src/lib/governance/lock.ts`, `web/src/components/tracking/gantt.tsx`, `web/src/app/api/tasks/route.ts`, `web/src/app/api/tasks/_query.ts`.
- Tests: R-65's triplicate enforcement (schema strip, API guard, DB trigger backstop) is covered by the project-lock migration and its accompanying test suite referenced in TRACEABILITY.md `[UNVERIFIED exact test file names]`.

## Open questions

- `[UNVERIFIED]` The exact console UI affordance for creating a milestone directly (as opposed to via the task's Milestone dropdown) was not located in the file set read for this catalogue.

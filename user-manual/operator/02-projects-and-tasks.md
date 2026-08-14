# 02 · Projects and tasks

**Status: ACTIVE** · Verified against `web/src/components/forms/project-form.tsx`, `web/src/components/forms/task-form.tsx`, `web/src/components/kanban/board.tsx`, `web/src/components/tracking/detail-panel.tsx`, and `web/src/app/(console)/projects/[id]/page.tsx`.

## Creating a project

From `/projects`, the "New Project" action opens a form with these fields (all wired to `POST /api/projects`, no fields beyond what's listed here exist in the current form):

Name, Code (e.g. `PROJ-001`), Program, Phase, Currency, RAG Status, Start Date, Target Date, Baseline Start, Baseline Target, Sponsor, Project Manager, Objective, Business Case, Scope Summary, Health Commentary.

A project lands on its own detail page (`/projects/[id]`) with eight tabs: **Charter, Overview, Activity, Board, Gantt, Risks, Issues, History**. Board and Gantt are covered below and in [`03-schedule-and-lock.md`](03-schedule-and-lock.md); Charter shows the project's charter document; History and Activity are the project-scoped audit trail (see [`04-approvals-and-trust.md`](04-approvals-and-trust.md) for the workspace-wide equivalent, the Trust Center).

## The Board tab — Kanban, and why drag is audited

The **Board** tab is a five-column Kanban (`Backlog → To do → In progress → Done → Canceled`), backed by `dnd-kit`. Dragging a task card between columns issues a `PATCH /api/tasks/[id]` changing `status_type` — **the same governed write path as editing the field by hand**. Per the constitution's "every mutation = exactly one immutable audit_log row" rule, a drag is not a UI-only convenience: it produces a real `task.update` audit row with before/after state, visible in the Trust Center.

If the task's project is locked, cards are not draggable (`useSortable({ disabled: isLocked })`) — see [`03-schedule-and-lock.md`](03-schedule-and-lock.md) for exactly what a lock does and doesn't block. Status changes are explicitly **not** blocked by a lock even when the project's schedule is frozen.

## Task fields

Opening a task's detail panel or the "New Task" form (`POST /api/projects/[id]/tasks`) exposes:

- **Core:** Name, Status, Priority (low/medium/high/urgent), Milestone, Completion %, Start Date, Due Date, Estimate (hours), Story Points, Assignee, Labels, Description.
- **Blocked by** — a dependency picker (see [`03-schedule-and-lock.md`](03-schedule-and-lock.md) for how dependencies drive the Gantt).
- **Acceptance Criteria** — free text: "Definition of done — what must be true for this task to be accepted?"
- **Checklist** — a list of sub-items, each with a done/not-done toggle. The detail panel shows a live progress bar (`N/M · pct%`) computed from checklist completion, separate from the task's own `completion_pct` field — the two are not automatically kept in sync, so update `completion_pct` yourself as work progresses.

Status values a task can be in: `backlog`, `unstarted`, `started`, `completed`, `canceled` — these map directly to the five Kanban columns above.

## Where to go next

- Scheduling, dependencies, and locking a project's baseline → [`03-schedule-and-lock.md`](03-schedule-and-lock.md)
- Deleting a project or task requires a second approver — see [`04-approvals-and-trust.md`](04-approvals-and-trust.md)

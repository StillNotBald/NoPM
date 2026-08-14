# 03 · Schedule and lock

**Status: ACTIVE** · Verified against `web/src/components/tracking/gantt.tsx`, `web/src/lib/governance/lock.ts`, `web/src/components/tracking/project-actions.tsx`, `web/src/app/api/tasks/[id]/dependencies/route.ts`, `web/src/app/api/tasks/[id]/route.ts`, `web/src/app/api/milestones/[id]/route.ts`, `web/src/lib/review/gather.ts`, and `web/src/app/api/rebaselines/`.

## The Gantt tab

The **Gantt** tab on a project's detail page renders tasks as bars against their `start_date`/`due_date`, colored by `status_type`, with dependency arrows drawn between them. It is read-mostly — you view the schedule shape here; you change it through task/milestone edits and the lock/rebaseline flow below, not by dragging bars.

## Dependencies

A dependency links two tasks with a `type` and an optional lag:

| Type | Meaning |
|---|---|
| `FS` (Finish-to-Start) | Successor can't start until predecessor finishes |
| `SS` (Start-to-Start) | Successor can't start until predecessor starts |
| `FF` (Finish-to-Finish) | Successor can't finish until predecessor finishes |
| `SF` (Start-to-Finish) | Successor can't finish until predecessor starts |

`lag_days` shifts the constraint by N days (negative values are lead time — the successor may start/finish that many days early). Set dependencies on a task's "Blocked by" field (see [`02-projects-and-tasks.md`](02-projects-and-tasks.md)); each add/remove is itself governed the same way schedule edits are — see below.

## Lock semantics — schedule frozen, work continues

Locking a project (the Lock/Unlock action on the project detail header) freezes the project's **schedule shape**, not the project itself. This is deliberate: a locked project should still be a place people do work.

**Blocked under lock** (fields verified in `web/src/lib/governance/lock.ts`):
- Task: `start_date`, `due_date`, `baseline_start_date`, `baseline_due_date`, `estimate_hours`, `milestone_id`, `project_id` (i.e. moving a task to a different milestone or project)
- Milestone: `start_date`, `target_date`, `baseline_target_date`
- Task/milestone **create**, task **delete-request**
- Dependency **add/remove**

**Stays editable under lock:** status / status_type (including Kanban drag), completion_pct, checklist, acceptance_criteria, name, description, labels, priority, assignee.

A blocked write returns `422` with code `project_locked` and a message telling you what to do next ("ask an admin to unlock it or apply a rebaseline") — it isn't a silent no-op. Each blocked attempt also writes a fail-soft audit row (see [`04-approvals-and-trust.md`](04-approvals-and-trust.md)) so a pattern of rejected writes is visible in the Trust Center, not just to the person who hit the wall.

## Rebaseline flow

To change the schedule shape of a locked project, the governed path is: **unlock is not required** — instead a **rebaseline** is proposed, reviewed, and applied while the lock stays on. In the current build:

1. A rebaseline is created against the project (`POST /api/projects/[id]/rebaselines`) — today this is done through the API/agent surfaces (CLI, MCP, or the BYOK assistant with a scoped token), not a console form.
2. A pending rebaseline shows up in the **Review Queue** (`/review`, filter tab "Rebaselines") as a "Rebaseline Sign-off" item. Clicking it deep-links to the project's detail page for context.
3. Sign-off and apply (`POST /api/rebaselines/[id]/signoff`, `POST /api/rebaselines/[id]/apply`) are, as of this writing, **API/agent-driven** — the console surfaces the pending item for visibility but does not yet expose an in-console sign-off button. If you need to sign off from the browser today, do it through the BYOK assistant panel or a scoped PAT via the CLI (see [`agents/README.md`](../agents/README.md)).

Applying a rebaseline is the one legitimate way dates get written to a locked project — the apply path runs inside a transaction-local bypass of the lock guard, not a general exception.

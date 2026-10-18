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

**Lock reason.** The Lock dialog proposes the reason "Baseline frozen" and lets you change it (up to 1,000 characters). The reason is kept on the project and in the audit row.

**Stays editable under lock:** status / status_type (including Kanban drag), completion_pct, checklist, acceptance_criteria, name, description, labels, priority, assignee.

A blocked write returns `422` with code `project_locked` and a message telling you what to do next ("ask an admin to unlock it or apply a rebaseline") — it isn't a silent no-op. Each blocked attempt also writes a fail-soft audit row (see [`04-approvals-and-trust.md`](04-approvals-and-trust.md)) so a pattern of rejected writes is visible in the Trust Center, not just to the person who hit the wall.

## Rebaseline flow

To change the schedule shape of a locked project, the governed path is: **unlock is not required** — instead a **rebaseline** is proposed, reviewed, and applied while the lock stays on. Everything below can be done from the **Baselines** page (`/baselines`), or through the API, the CLI or an MCP client:

1. **Propose.** On `/baselines`, choose **Propose rebaseline**, pick the project and write the reason (required: approvers sign what you write). The current and proposed plan boxes are optional. A project can have only **one** rebaseline waiting for sign-off; a second proposal is refused with "This project already has a rebaseline waiting for sign-off".
2. **Sign off.** A pending rebaseline shows in the **Review Queue** (`/review`, tab "Rebaselines") and on `/baselines`. An admin or manager who is **not** the person who proposed it chooses **Sign off rebaseline** and votes go or no-go (a no-go needs a reason). Anyone else sees the status and a note instead of buttons: "Only managers and admins can approve", or "You proposed this. A different manager or admin must sign off and apply it."
3. **Apply.** Once approved, an admin or manager other than the proposer chooses **Apply**. The project's milestone, task **and** project baseline dates move to the current plan, and the audit trail records the project baseline before and after. Applying is refused if the project is no longer locked ("Rebaseline cannot be applied: its project is no longer locked. Lock the project and propose a new rebaseline.").

Each step is saved together with its audit row in one step, so a failed audit write cannot leave a change unrecorded, and a failed apply can simply be repeated.

Applying a rebaseline is the one legitimate way dates get written to a locked project — the apply path runs inside a transaction-local bypass of the lock guard, not a general exception.

## Unlocking — read the warning

Unlocking a project is still a one-person action: choose **Unlock**, give a reason (required), confirm. **Unlocking cancels every pending and approved rebaseline** of that project, because a sign-off must never be applied to dates edited after it. The Unlock dialog lists what will be cancelled ("Unlocking cancels 2 pending/approved rebaselines: …") before you confirm. Applied, rejected and draft rebaselines are left alone. After editing the dates, lock the project again and propose a new rebaseline if it still needs to move.

## Baselines page

`/baselines` (Governance section of the sidebar) is the console's home for this flow: a **Locked baselines** table (every locked project, who locked it, when, and why) and a **Rebaselines** table (every rebaseline, its status, when it was requested, and its sign-off count) with the Propose, Sign off and Apply controls described above. It exists so the lock → rebaseline → sign-off → apply story doesn't require opening an individual project or the Review Queue. Members and viewers can read it; the decision buttons appear only to admins and managers.

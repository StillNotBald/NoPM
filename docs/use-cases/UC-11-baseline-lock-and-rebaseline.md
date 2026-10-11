# UC-11 · Baseline lock and rebaseline

**Goal:** Freeze a project's approved schedule shape so it can't drift by accident, while day-to-day work continues, and provide a reviewed path (rebaseline) for legitimate schedule changes afterward.

**Actors:** Admin / Project Manager (locks, proposes rebaseline), Approver / second pair of eyes (signs off). AI agent via token can propose and (per its scope) sign off/apply, but console sign-off is not yet exposed as a button — see below.

**Preconditions:** A project exists with a schedule (tasks/milestones with dates).

**Trigger:** A project's plan is approved and should stop moving without a formal process, or a locked project's schedule genuinely needs to change.

## Main flow — lock

1. `POST /api/projects/{id}/lock` (scope `project:write`) — UI: Lock action on the project detail header. Reason is optional on lock (unlike unlock, see below). Milestone/task **baselines** are captured at lock time (`baseline_start_date`/`baseline_target_date`/`baseline_due_date`), so slip later renders as ghost bars plus variance on the Gantt (R-33).
2. Locking freezes **schedule shape only**: task `start_date`, `due_date`, `baseline_start_date`, `baseline_due_date`, `estimate_hours`, `milestone_id`, `project_id`; milestone `start_date`, `target_date`, `baseline_target_date`; task/milestone **create**; task **delete-request**; dependency add/remove. Status, completion_pct, checklist, acceptance_criteria, name, description, labels, priority, and assignee all stay editable — locking a project does not stop people from working on it.
3. `/baselines` (Governance nav) is the read-only console home for this flow: a "Locked baselines" table (every locked project, who locked it, when, why) and a "Rebaselines" table (status, requested-at, sign-off count) — a register, not a form.

## Main flow — rebaseline

1. Propose: `POST /api/projects/{id}/rebaselines` (scope `project:write`, reason required). As of this build, this is done through the API/agent surfaces (CLI, MCP, or the BYOK assistant with a scoped token) — there is no console form for step 1.
2. The pending rebaseline appears in the **Review Queue** (`/review`, "Rebaselines" filter tab) as a "Rebaseline Sign-off" item, deep-linking to the project detail page.
3. Sign off: `POST /api/rebaselines/{id}/signoff` (scope `rebaseline:approve`).
4. Apply: `POST /api/rebaselines/{id}/apply` (scope `rebaseline:approve`). Applying runs inside a transaction-local bypass of the lock guard (`nopm.lock_bypass`, migration `20260814000028`) — the one legitimate way dates get written to a locked project, never a general exception to the lock.
5. Sign-off and apply are, as of this writing, API/agent-driven only — the console surfaces the pending item for visibility but has no in-console sign-off button yet; doing this from the browser today means using the BYOK assistant panel or a scoped PAT via the CLI.

## Alternate and exception flows

- **A write touching schedule-shape fields on a locked project (outside the rebaseline-apply RPC)** → `422` `project_locked`, message tells the caller to ask an admin to unlock or propose a rebaseline. Enforced three ways: schema strip (`is_locked` removed from the general project update schema — lock state changes only via the dedicated lock/unlock routes), an API guard (`assertProjectUnlocked`/`touchesScheduleShape` in `web/src/lib/governance/lock.ts`), and a DB trigger backstop (migration `0028`) as a last line of defense. The write is still rejected even if the API guard were somehow bypassed.
- **Blocked attempt** → still writes a fail-soft `*.blocked` audit row (e.g. `task.update.blocked`), never affecting the response — this makes a pattern of repeated denied attempts visible in the Trust Center, not silently swallowed.
- **Unlock without a reason** → `422`. Unlike lock, `POST /api/projects/{id}/unlock` **requires** `{ reason }` (R-83) — recorded in the audit `after` payload as `unlock_reason`, not stored on the row itself.
- **Missing `project:write` / `rebaseline:approve`** → `403`.

## Postconditions

- Lock: one audit row for the lock action; every subsequent blocked write attempt writes its own fail-soft `*.blocked` row.
- Unlock: one audit row carrying `after.unlock_reason`.
- Rebaseline: one audit row each for propose, signoff, and apply.
- The Gantt shows baseline-vs-actual ghost bars and variance once a lock has captured a baseline.

## Reporting and evidence

- `/baselines` register page (Locked baselines + Rebaselines tables).
- Gantt slip visualization (current vs baseline, R-33) is itself a reporting surface — a reviewer can see schedule drift without reading the audit log.
- Diagram: [`project-lock-rebaseline-flow.html`](../processes/project-lock-rebaseline-flow.html) is planned in this same work item; it did not exist on disk at the time this catalogue was written.

## Traceability

- R-IDs: R-04 (Control-Tower lock → rebaseline sign-off), R-33 (Gantt baselines), R-65 (project-lock enforcement in triplicate), R-83 (governed unlock requiring a reason).
- Key files: `web/src/app/api/projects/[id]/lock/route.ts`, `web/src/app/api/projects/[id]/unlock/route.ts`, `web/src/app/api/projects/[id]/rebaselines/route.ts`, `web/src/app/api/rebaselines/[id]/signoff/route.ts`, `web/src/app/api/rebaselines/[id]/apply/route.ts`, `web/src/lib/governance/lock.ts`, migrations `20260814000028`, `20260814000030`, `20260814000031`.
- Tests: `[UNVERIFIED exact test file names]` for the lock triplicate enforcement, referenced by description in `requirements/REQUIREMENTS.md` R-65 but not read directly.

## Open questions

- `[UNVERIFIED]` Exact test file names covering the lock-enforcement triplicate.
- The `project-lock-rebaseline.html` diagram gap is flagged in the report.

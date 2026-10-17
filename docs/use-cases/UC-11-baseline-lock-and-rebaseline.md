# UC-11 · Baseline lock and rebaseline

**Goal:** Freeze a project's approved schedule shape so it can't drift by accident, while day-to-day work continues, and provide a reviewed path (rebaseline) for legitimate schedule changes afterward.

**Actors:** Any actor with `project:write` locks the project and proposes a rebaseline (the guard does not separate admin, manager and member). Approver / second pair of eyes (an admin or manager) signs off, as a different person from the requester, and an admin or manager applies. AI agent via token can propose through the REST API, the `nopm` CLI or the stdio MCP server; sign-off and apply work only when the token carries `rebaseline:approve` AND its creator is currently an admin or manager. The BYOK assistant has no rebaseline tool. The console now has the controls (see the update below).

**Preconditions:** A project exists with a schedule (tasks/milestones with dates).

**Trigger:** A project's plan is approved and should stop moving without a formal process, or a locked project's schedule genuinely needs to change.

## Main flow — lock

1. `POST /api/projects/{id}/lock` (scope `project:write`) — UI: Lock action on the project detail header. Reason is optional on lock (unlike unlock, see below). Milestone/task **baselines** are captured at lock time (`baseline_start_date`/`baseline_target_date`/`baseline_due_date`), so slip later renders as ghost bars plus variance on the Gantt (R-33).
2. Locking freezes **schedule shape only**: task `start_date`, `due_date`, `baseline_start_date`, `baseline_due_date`, `estimate_hours`, `milestone_id`, `project_id`; milestone `start_date`, `target_date`, `baseline_target_date`; task/milestone **create**; task **delete-request**; dependency add/remove. Status, completion_pct, checklist, acceptance_criteria, name, description, labels, priority, and assignee all stay editable — locking a project does not stop people from working on it.
3. `/baselines` (Governance nav) is the console home for this flow: a "Locked baselines" table (every locked project, who locked it, when, why) and a "Rebaselines" table (status, requested-at, sign-off count) with the propose, sign-off and apply controls (update below).

## Main flow — rebaseline

1. Propose: `POST /api/projects/{id}/rebaselines` (scope `project:write`, reason required). As of this build, this is done through the REST API or the `nopm rebaselines` CLI. The MCP server and the BYOK assistant have no rebaseline tool, and there is no console form for this step.
2. The pending rebaseline appears in the **Review Queue** (`/review`, "Rebaselines" filter tab) as a "Rebaseline Sign-off" item, deep-linking to the project detail page.
3. Sign off: `POST /api/rebaselines/{id}/signoff` (scope `rebaseline:approve`). The signer must be a different person from the requester; a token counts as the person who minted it.
4. Apply: `POST /api/rebaselines/{id}/apply` (scope `rebaseline:approve`). Applying runs inside a transaction-local bypass of the lock guard (`nopm.lock_bypass`, migration `20260814000028`) — the one legitimate way dates get written to a locked project, never a general exception to the lock.
5. Sign-off and apply are, as of this writing, REST and CLI only. The console surfaces the pending item for visibility but has no sign-off or apply button; use the REST API or `nopm rebaselines` with a token that holds `rebaseline:approve`. The BYOK assistant cannot perform either step.

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
- Diagram: [`project-lock-rebaseline-flow.html`](../processes/project-lock-rebaseline-flow.html).

## Update 2026-10-17 — journey-audit fixes

- **Rebaseline controls on `/baselines` (R-118).** Propose (reason required), sign off go or no go, and apply are buttons on the page, calling the same API routes the CLI and agents use. Sign-off and apply are shown only to admins and managers (not the proposer); everyone else sees status only.
- Owner decision 16 ("follow Lark rules", ADR 0014, R-113): approving or deciding is for admins and managers only, on every channel. A member or viewer gets `403` `role_not_permitted` ("Only managers and admins can approve"). A token is judged by the CURRENT role of the person who minted it, so a member cannot approve through a token and a demoted manager's token stops approving at once. It covers sign-off and apply.
- **One at a time.** A project may have only one rebaseline waiting for sign-off: a second proposal is `409` `pending_rebaseline_exists` ("This project already has a rebaseline waiting for sign-off").
- **Apply needs a locked project.** If the project was unlocked after sign-off, apply is `422` `project_not_locked` ("Rebaseline cannot be applied: its project is no longer locked. Lock the project and propose a new rebaseline."). Unlocking already cancels pending and approved rebaselines; the console now WARNS what will be cancelled before you confirm the unlock.
- **Lock reason is editable.** The lock dialog proposes a reason and lets you change it; it is recorded on the project and in the audit row.
- **All-or-nothing.** Lock, unlock, sign-off and apply each run as one database transaction with the audit row inside (`nopm_lock_project`, `nopm_unlock_project_audited`, `nopm_signoff_rebaseline`, `nopm_apply_rebaseline`; migrations 0062 and 0063). A failed audit write rolls the change back instead of leaving it unrecorded, and an apply can be retried.

## Traceability

- R-IDs: R-04 (Control-Tower lock → rebaseline sign-off), R-33 (Gantt baselines), R-65 (project-lock enforcement in triplicate), R-83 (governed unlock requiring a reason).
- Key files: `web/src/app/api/projects/[id]/lock/route.ts`, `web/src/app/api/projects/[id]/unlock/route.ts`, `web/src/app/api/projects/[id]/rebaselines/route.ts`, `web/src/app/api/rebaselines/[id]/signoff/route.ts`, `web/src/app/api/rebaselines/[id]/apply/route.ts`, `web/src/lib/governance/lock.ts`, migrations `20260814000028`, `20260814000030`, `20260814000031`.
- Tests: `[UNVERIFIED exact test file names]` for the lock triplicate enforcement, referenced by description in `requirements/REQUIREMENTS.md` R-65 but not read directly.

## Open questions

- `[UNVERIFIED]` Exact test file names covering the lock-enforcement triplicate.

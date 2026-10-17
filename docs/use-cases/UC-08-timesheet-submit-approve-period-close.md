# UC-08 · Timesheet submit, approve, and period-close

**Goal:** Log time against a project, submit a week for approval, have a second person approve it (locking that week against further edits), and, if needed, formally reopen it.

**Actors:** Team member (logs time, submits), Approver / second pair of eyes (an admin or manager who approves, rejects, or reopens; must be a different person from the submitter), Finance/PMO (consumes the time report).

**Preconditions:** The team member is a `resource_member` with a cost rate. The week being submitted has at least one time entry (submission of an empty week is rejected).

**Trigger:** A billing/reporting cycle closes, or a manager needs an accurate weekly time picture.

## Main flow

1. Log time: UI `/timesheets` (sidebar: Capacity) "log time" form, or `POST /api/time-entries` (scope `time:write`). Cost is auto-computed as `hours * member.cost_rate`, snapshotted at entry time — not recomputed later even if the member's rate changes. `billable` defaults from the project's `default_billable` when omitted (R-68/L-29); an explicit `true`/`false` always wins.
2. Submit the week: `POST /api/timesheet-submissions` (scope `time:submit`) with `period_start` as a Monday. Snapshots `hours_total`/`entry_count` from that week's `time_entries` at submit time, never recomputed afterward. `422` if there is nothing to submit for that member+period, or an open submission already exists for it.
3. UI: the submit panel on `/timesheets` surfaces this as a "Submit" action on the weekly grid; the submission also appears in the Review Queue (`/review`) as a `timesheet` item with an inline two-step decide action.
4. Approve or reject: `POST /api/timesheet-submissions/{id}/decision` (scope `time:approve`) with `{decision: "approved"|"rejected", rationale}`. **The deciding person must differ from the submitter** (a token counts as the person who minted it) — enforced on approve, reject and reopen (guard symmetry). Rationale is required on reject.
5. Approval **locks the week**: `POST /api/time-entries` and `DELETE /api/time-entries/{id}` for that member+week now reject `422` (period-close lock, R-76), enforced both at the API route (`assertWeekUnlocked`) and by a DB trigger backstop with no bypass GUC — even a service-role writer cannot slip an entry into a closed week.
6. Reopen a previously approved week: same decision endpoint, `{decision: "reopened", rationale}` — allowed only on `status=approved` submissions (`422` otherwise), rationale required, self-reopen blocked `403` by the same compound guard as approve/reject. Reopening reverts the submission to `submitted`, re-enters the Review Queue, and fail-soft re-notifies approvers.

## Alternate and exception flows

- **Self-approval, self-rejection, or self-reopen** → `403` on all three verbs (guard symmetry — an earlier defect had this gap on reject only; it is now closed on all three, see memory `guard-symmetry-approve-reject`).
- **Log/delete a time entry against an already-approved week** → `422`, period-close lock, both `POST /api/time-entries` and `DELETE /api/time-entries/{id}`.
- **Submit an already-open period** → `422`, duplicate-submission guard (partial unique index blocks a second open submission per member+week).
- **Reject/approve a submission not in `status=submitted`** → `422`.
- **`time:approve` on an agent token** → no MCP tool and no assistant tool carries `time:approve`, and the agent preset never includes it (asserted in the scope-ceiling tests). A token minted with `time:approve` can still decide a timesheet, but only one submitted by a different person than the token's owner.

## Postconditions

- One audit row per governance step: `timesheet.submitted`, `timesheet.approved`/`timesheet.rejected`, `timesheet.reopened`.
- Approved weeks are visibly locked on the weekly grid and submit panel.
- Fail-soft `approval.*` notifications to the relevant parties.

## Reporting and evidence

- `/timesheets` weekly grid: Mon–Sun columns per member, "0" distinguishable from "—" (not submitted), row/column/grand totals, capacity shown against the week.
- Filtered time report (member/project/date-range/billable) with by-member/by-project totals from `aggregateTimeReport` — cost is always the entry's snapshotted cost, never the member's current rate; the caption states the reconciliation rule against `/budget`.
- `GET /api/export?entity=time_entries` (`project_id`/`member_id`/`date_from`/`date_to`/`billable` filters) for the governed CSV export.
- Diagrams: [`timesheet-lifecycle-flow.html`](../processes/timesheet-lifecycle-flow.html) and, for the lock/reopen sub-flow, [`period-close-reopen-flow.html`](../processes/period-close-reopen-flow.html), both in `docs/processes/`.

## Update 2026-10-17 — journey-audit fixes

- Owner decision 16 ("follow Lark rules", ADR 0014, R-113): approving or deciding is for admins and managers only, on every channel. A member or viewer gets `403` `role_not_permitted` ("Only managers and admins can approve"). A token is judged by the CURRENT role of the person who minted it, so a member cannot approve through a token and a demoted manager's token stops approving at once. It covers approve, reject AND reopen.
- **Own hours only (decision 17, to be confirmed by the owner; R-114).** A member logs, edits and deletes only their own time entries: `POST` and `DELETE /api/time-entries` answer `403` `not_your_hours` ("You can only log your own hours") for someone else's hours. Admins and managers may act for others. The log-time form offers a member only themselves. `task_id` must belong to the entry's project (`422`).
- **Retry-safe logging (R-115).** `POST /api/time-entries` accepts an `Idempotency-Key` header; a retry with the same key returns the first entry.
- **Console.** A rejected week can be resubmitted from the submit panel, and a reopened week can be amended and resubmitted; approve and reject buttons are hidden from members and viewers.

## Traceability

- R-IDs: R-17 (Timesheets), R-74 (time report + weekly grid + timesheet four-eyes), R-76 (period-close lock + reopen verb), R-38 (Review Queue `timesheet` kind).
- Key files: `web/src/app/api/time-entries/route.ts`, `web/src/app/api/time-entries/[id]/route.ts`, `web/src/app/api/timesheet-submissions/route.ts`, `web/src/app/api/timesheet-submissions/[id]/decision/route.ts`, `web/src/lib/governance/timesheet-decision.ts`, `web/src/lib/governance/period-lock.ts`, `web/src/components/timesheets/week-grid.tsx`, `web/src/components/timesheets/submit-panel.tsx`, migrations `20260815000038` and `20260815000040`.
- Tests: `ts_maker_checker` DB CHECK; guard-symmetry unit tests across approve/reject/reopen; the `nopm_assert_week_unlocked` DB trigger backstop (errcode `P0011`).

## Open questions

None outstanding for the flow itself.

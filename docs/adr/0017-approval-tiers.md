# ADR 0017 — Approval tiers, turnaround timers and the emergency path

- **Status:** Accepted (change request CR-2026-10-18-01, owner scope approval 2026-10-18; assumptions A1 and A3)
- **Date:** 2026-10-18
- **Builds on:** ADR 0013 (principal-aware four-eyes), ADR 0014 (approver roles), ADR 0015 (common-pattern defaults)
- **Closes:** audit gaps G1, G2, G3, G4 and G7 (`_docs/directions-2026-10-17/NOPM_AUDIT_REPORT.md`)
- **Requirements:** R-148 (tiers and routing), R-149 (timers and auto-approve), R-150 (emergency path)

## Context

ADR 0015 settled how approval works with two fixed tiers. Routine and normal change requests, and all deletions, were decided by a manager or an admin. Nothing in the product said that a large cost or a schedule move needed a higher decider. The audit rated five gaps:

| Gap | What the audit found |
|---|---|
| G1 | Approval tiers were missing. ADR 0015 fixed two tiers in code, and the settings held only the time zone. |
| G2 | Tier routing was missing. One rule applied: an admin or a manager decides on every channel. |
| G3 | No due date, turnaround timer or expiry existed on any approval table, so nothing escalated. Auto-approve on timeout was a question for the owner. |
| G4 | No emergency state existed. The only emergency lever, unlocking a project, needed no retro approval. |
| G7 | The cost was stored and shown, but never read for routing. There was no threshold. |

The brief names five tiers. The owner asked for all of them to be built, with defaults that can be changed without a code release.

## Decision

### Five tiers

| Tier | Default decider | Turnaround | Who may request it |
|---|---|---|---|
| `routine` | Manager or admin | 24 h | Anyone with write access, and only with no cost, no schedule impact and no impact scope. The database lifts a routine request that gains one to `normal`. |
| `normal` | Manager or admin | 48 h | Anyone with write access. This is the default. |
| `high_risk` | Admin | 72 h | Anyone with write access. A cost at or over the threshold raises `normal` to this tier. |
| `strategic` | Admin | 120 h | Admin only |
| `emergency` | Admin, as the retro decision | Retro window, 48 h | A manager or admin, with `is_emergency` |

Project deletion is `high_risk` by default. Task deletion and rebaselines are `normal`.

The server can raise a tier and never lower it. A requester may ask for `routine` only with no cost and no schedule impact. A request that breaks that rule is refused with 422 on the `tier` field.

### Policy per workspace

`workspaces.approval_policy` (migration 0100) holds the rules. An empty value means every default. An admin edits it in the Settings page, in the approval-policy card, or through `PATCH /api/workspace-settings`.

| Setting | Default | Range |
|---|---|---|
| Decider role, per tier | As the table above | `manager` or `admin` |
| Turnaround hours, per tier | 24, 48, 72, 0 (emergency), 120 | 0 to 8760; 0 means no timer |
| Routine auto-approve, per tier | Off everywhere | On for `routine` only |
| Cost threshold | 50,000 | Either sign; at or over it, a normal request becomes `high_risk` |
| Schedule threshold | 10 days | 0 to 3650; a schedule impact above it does the same |
| Currency | MYR (a label, or unset) | Label only. Costs are compared as plain numbers and nothing is converted. |
| Emergency retro window | 48 h | 1 to 720 h |

The database holds the same rules as the code (`nopm_tier_required_role` and the tier triggers). The route gives the clean error, and the database refuses anything the route missed.

### Routing and enforcement

- The raise route notifies only the people who may decide the tier. An admin-level tier notifies admins. A named assignee is notified alone, and only when that person is eligible.
- An assigned approver below the tier's role is refused at raise (422).
- At decision time the route refuses a manager on an admin-level tier with 403 `role_not_permitted` and the sentence "This request needs an admin to decide it." The same check runs in the decision RPC and in the rebaseline sign-off.
- The change-control inspector offers Approve only to a person whose role meets the tier.

### Timers

- Every waiting request gets `approval_deadline_at`, the raise time plus the tier's turnaround. A `deadline_set` event is written at the same time.
- The existing daily scheduler (`runCron().approvals`) runs once per workspace. It reminds approvers at half the turnaround, escalates to admins past the deadline, and writes one `approval.timer_run` audit row per workspace in which it looked at anything.
- The timer never writes to the request row. An approver's pinned version stays valid.
- Events are unique per request and kind, so a second run on the same day does nothing (`approval_events`, migration 0101).

### Routine auto-approve is off by default

Auto-approve approves a routine change request nobody decided by its deadline. It is built, and it is off until an admin switches it on. It applies only when all of these hold: the workspace has switched it on, the tier is `routine`, the request is not an emergency, it has no cost and no schedule impact, it is still waiting, and its deadline has passed. A deletion request and a rebaseline are never auto-approved. The database function `nopm_auto_approve_routine` checks every one of these, and the decision is written with the system actor `system:auto-approve (policy)`, with no principal and one audit row. With the policy off, a late routine request is escalated and never approved.

### Emergency path

- A manager or admin raises a change with `is_emergency: true`. The request gets status `emergency`, tier `emergency`, `retro_due_at` set to now plus the retro window, and no ordinary deadline.
- An emergency may be implemented at once, through the existing implement route. It stays flagged.
- The retro decision is the ordinary decide route, approve or reject, by the emergency tier's role (an admin by default). The raiser cannot give it. The change stays `implemented`, because it has happened, and `retro_decided_at` and `retro_outcome` are stamped.
- A live emergency with no retro decision past `retro_due_at` is overdue. The timer marks it once and notifies admins. The digest, the weekly report, the review queue and the audit pack all show it.

### Currency threshold

A normal change request whose cost is at or over the threshold becomes `high_risk`. The check uses the absolute value, so a credit is caught as well. A schedule impact above `schedule_threshold_days` (default 10) does the same. The currency is a label only (default MYR, or unset): every cost is compared as a plain number in the workspace's own currency, and nothing is converted. The first build treated a cost in another currency as `high_risk`; the wave-4 fix pass removed that rule.

## Consequences

- Every governed request now has a tier. The approvals queue and the change-control page show it.
- An admin can change who decides, and how long a decision may take, without a release. Those changes are audited with before and after values.
- Some existing deletions now need an admin. A project deletion is `high_risk` by default, so a manager who used to decide it can no longer do so unless the workspace policy moves that tier to managers.
- The change request schema grows: `tier`, `approval_deadline_at`, `is_emergency`, `retro_due_at`, `retro_decided_at` and `retro_outcome`. Migrations 0100 and 0101 must be applied before the build serves traffic.
- Routine auto-approve, if switched on, moves a decision to the system actor. The audit row says so, and the requester is told.
- Fallback approver (owner decision D7): in a workspace with fewer than two admins, a manager may decide an admin-level request. The decision is recorded with `fallback_approver` true (on a deletion or rebaseline, a separate `approval.fallback_approver` audit row). Four-eyes still bars the raiser. Without this rule a single-admin workspace could never decide a high-risk change. The owner chose it; with two or more admins the rule does not apply.
- An emergency can still be edited or withdrawn by its requester until it is implemented. After implementation it stays part of the record.

## What stays

| Stays | Why |
|---|---|
| A second human decides money and dates. | This is the owner's stance. Auto-approve is off by default and cannot touch a request that carries cost or schedule impact. |
| Four-eyes by person. | A token counts as the person who minted it. An emergency retro decision also cannot be given by the raiser. |
| One audit row per mutation. | The tier, the timer and the emergency path all write through the same audited path. |
| The timer does not decide. | It reminds, escalates and flags. Only a person, or the routine policy an admin switched on, decides. |
| The defaults are placeholders. | The turnaround and threshold figures are starting points. The owner changes them in Settings. |

## Alternatives considered

- **Keep two tiers and add a cost check in the UI.** Rejected: the rule would live in the screen and be bypassed by the API, the CLI and the agent tools.
- **Auto-approve on by default.** Rejected: it would remove the second human from money and dates without the owner's choice.
- **Emergency as a flag on a normal request.** Rejected: an emergency needs its own status and its own retro role, so a report can count it.
- **External anchoring of the audit hash chain.** Deferred. Migration 0104 gives tamper evidence inside the database. Anchoring outside it is a later decision.

## Traceability

- Migrations: `web/supabase/migrations/20261018000100_approval_tiers.sql`, `web/supabase/migrations/20261018000101_approval_timers.sql`.
- Code: `web/src/lib/governance/tiers.ts`, `web/src/lib/governance/timers.ts`, `web/src/lib/auth/approver.ts`, `web/src/lib/governance/decide.ts`.
- Tests: `web/src/lib/governance/tiers.test.ts`, `web/src/lib/governance/timers.test.ts`, `web/src/lib/governance/decide.tiers.test.ts`.
- Use cases: `docs/use-cases/UC-31-approval-tiers-and-emergency-change.md`.

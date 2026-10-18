# UC-31 · Approval tiers, turnaround timers and the emergency change

**Goal:** Make the approval line match the size of the change. A small change is decided by a manager. A large cost or a schedule move is decided by an admin. A change that must ship at once commits when it is raised, with no approval and no retro, and is flagged as an emergency everywhere it is listed. The admin sets these rules in Settings, without a code release.

**Actors:** Admin (sets the policy), manager (raises and decides routine and normal changes), project manager or team member (raises a change, no decision right).

**Preconditions:** Migrations 0100 and 0101 are applied before the build serves traffic. The approval policy is optional: a workspace with no policy row gets the defaults.

**Trigger:** A change request is raised. Either it is a normal change, or it is urgent and cannot wait for the usual approval.

## Main flow

1. An admin opens **Settings**, then the **Approval policy** card below the Invites section. Managers see it too, but only an admin can edit it. Five rows show who decides each tier, the turnaround hours, and a routine-only auto-approve checkbox with a warning. Below them sit the cost threshold and the currency. The rows stack at phone width.
2. The admin changes a row and saves. The change is audited once, with the before and after values of the policy.
3. A team member raises a change request under a project. The form asks for a tier. Leave it as normal, or pick routine, high risk or strategic. Routine is offered only when the change has no cost and no schedule impact.
4. The change is raised with the tier stored and an approval deadline set. Approvers who may decide that tier are notified. The requester is not.
5. A manager opens the change-control page and sees the tier badge. A manager cannot approve a high-risk change. The refusal reads "Only admins can approve a high-risk request."
6. For an urgent change, a manager or admin with a user session, or a token that holds the exact `change:decide` scope, ticks **Emergency** on the form. The change commits at once: it is stored as approved with tier emergency and the emergency flag. It has no approver, no approval deadline and no retro decision.
7. The team implements the emergency change at once, with **Mark implemented**.
8. The emergency stays flagged in the change list, the change detail, the weekly report ("Emergency changes this week") and the audit pack. Nobody decides it afterwards.

## Alternate and exception flows

- **Routine tier with a cost or schedule impact** → `422`, field `tier`. The request is not saved.
- **Strategic tier asked by a manager** → `403` `role_not_permitted`.
- **Emergency asked by a member or viewer** → `403` `role_not_permitted`. Nothing is stored.
- **Emergency asked with a token that lacks the exact `change:decide` scope** (`change:*` and `change:write` are not enough) → `403`, see the route for the exact code. Nothing is stored.
- **Approve, reject or defer on an emergency** → `422` `already_decided`. Nobody decides it.
- **A cost at or over the threshold on a normal change** → the server raises it to high risk. The requester cannot lower it again.
- **An assigned approver below the tier's role** → `422` `invalid_assigned_approver`, refused at raise.
- **Turnaround passes with no decision** → the daily scheduler reminds approvers at half the turnaround, then escalates to admins past the deadline. It never approves on its own, unless the admin has switched routine auto-approve on for that tier.
- **Routine auto-approve switched on, and a routine change with no cost and no schedule impact passes its deadline** → approved by the system under the policy. The requester is told. The audit row carries the policy as the reason. Deletions and rebaselines are never auto-approved.

## Postconditions

- Each raise writes one `change_request.create` audit row with the tier and the deadline in the after.
- Each policy change writes one `workspace.settings_update` audit row with `approval_policy` before and after.
- Each timer run writes one `approval.timer_run` row per workspace in which it looked at anything, with the counts.
- An emergency raise also writes `change_request.emergency_commit`, with the raiser as the actor.

## Evidence produced

- The change request row, with `tier`, `approval_deadline_at`, `is_emergency`. The fields `retro_due_at`, `retro_decided_at` and `retro_outcome` are deprecated history.
- The policy row, with every default filled in on read.
- The audit rows above.
- The emergency flag, visible in the audit pack CSV as `tier` and `is_emergency` (yes, or blank). The columns `retro_due_at`, `retro_decided_at` and `retro_outcome` are history, and `retro_overdue` is deprecated and blank.

## API calls

- `GET /api/workspace-settings` returns `approval_policy` with every default filled in (any signed-in user).
- `PATCH /api/workspace-settings` takes any subset of `approval_policy` (admin session only). `auto_approve` is allowed only on `routine`.
- `POST /api/projects/{id}/change-requests` takes `tier` and `is_emergency` (scope `change:write`; an emergency also needs a session or the exact `change:decide` scope).
- `POST /api/change-requests/{id}/implement` accepts an approved change, which includes an emergency (scope `change:write`).
- `POST /api/change-requests/{id}/decision` answers `422` `already_decided` on an emergency.
- `GET /api/review` lists what is waiting, with `tier` and `approval_deadline_at` on each item. An emergency never appears there, and the items no longer carry `retro_due_at` or `retro_overdue`.

## Reporting and evidence

- The audit pack marks every emergency in the `is_emergency` column.
- The weekly report carries a section "Emergency changes this week: N" with up to ten references and titles.

## Traceability

- R-IDs: R-148 (tiers and routing, audit gaps G1, G2, G7), R-149 (timers and auto-approve, G3), R-150 (emergency path, G4).
- Decision record: `docs/adr/0017-approval-tiers.md`.
- Key files: `web/supabase/migrations/20261018000100_approval_tiers.sql`, `web/supabase/migrations/20261018000101_approval_timers.sql`, `web/src/lib/governance/tiers.ts`, `web/src/lib/governance/timers.ts`, `web/src/lib/auth/approver.ts`, `web/src/lib/governance/decide.ts`, `web/src/components/integrations/approval-policy-card.tsx`, `web/src/components/change-control/change-detail.tsx`.

## Open questions

- The turnaround and threshold defaults are placeholders. The owner has not yet confirmed them.
- Whether routine auto-approve should be on for any workspace is the owner's decision. It is off until then.

## Superseded 2026-10-18

Owner decision Q1 replaced the retro model described in earlier versions of this use case. An emergency now commits when it is raised and is only a flag. See `docs/adr/0017-approval-tiers.md`.

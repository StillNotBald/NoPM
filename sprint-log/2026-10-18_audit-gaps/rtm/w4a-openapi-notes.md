# W4-A OpenAPI / llms.txt notes (for the docs agent)

No new route. Existing routes gain fields and error cases.

## `POST /api/projects/{id}/change-requests` (raise)
- New optional body fields:
  - `tier`: `routine | normal | high_risk | strategic`. `routine` only with no `impact_cost` and no `impact_schedule_days` (else 422 with `fields: [{field: "tier"}]`). `strategic` only for an admin (else 403 `role_not_permitted`). The server can raise the tier and never lowers it: a normal request whose `|impact_cost|` is at or over the workspace threshold (default 50,000) becomes `high_risk`; a cost in a currency other than the policy currency (when the policy names one) is also `high_risk`. `emergency` is not accepted here (422).
  - `is_emergency`: boolean. Only a manager or admin (a token is judged by the role of the person who minted it); else 403 `role_not_permitted` and nothing is stored. Gives status `emergency`, tier `emergency`, `is_emergency` true, `retro_due_at` = now + the workspace emergency window (default 48 h), `approval_deadline_at` null. The request can be implemented at once (`POST /change-requests/{id}/implement` accepts status `emergency`).
- Response row gains: `tier`, `approval_deadline_at` (null for an emergency or when the tier has 0 turnaround hours), `is_emergency` (only present once migration 0100 is applied; false for ordinary rows), `retro_due_at`, `retro_decided_at`, `retro_outcome` (`approved | rejected | deferred`).
- `assigned_approver_id` is now also refused (422 `invalid_assigned_approver`) when the tier needs an admin and the person is a manager.
- Notifies the people who may decide the tier with `approval.requested` (admins only for an admin-level tier; the assigned approver alone when named); never the requester.

## `DELETE /api/tasks/{id}` and `DELETE /api/projects/{id}` (raise a deletion request, 202)
- The returned deletion request carries `tier` (project: `high_risk`, task: `normal`, unless the workspace policy only changes who decides) and `approval_deadline_at`.

## `POST /api/projects/{id}/rebaselines`
- The returned rebaseline carries `tier` (`normal`) and `approval_deadline_at`.

## Decision routes (new 403 case, same code)
- `POST /api/change-requests/{id}/decision`, `POST /api/deletion-requests/{id}/approve|reject`, `POST /api/rebaselines/{id}/signoff`, and the chat card actions: 403 `role_not_permitted` with message "This request needs an admin to decide it." when the request's tier asks for an admin and the decider is a manager (or the policy asks for an admin for a lower tier). The database repeats the rule (P0018).
- `POST /api/change-requests/{id}/decision` also accepts a change request in status `emergency` and a live emergency (status `implemented`, `is_emergency` true, `retro_decided_at` null): the retro decision. It needs the emergency tier's role (admin by default) and a different person from the raiser. `approve | reject` only for a live change (`defer` is 422 `invalid_transition`). A live change stays `implemented`; `retro_decided_at` and `retro_outcome` are stamped; the response `status` is the decision.

## `GET /api/change-requests`
- `status` filter accepts `emergency`. `view=full` and `fields=` accept `tier, approval_deadline_at, is_emergency, retro_due_at, retro_decided_at, retro_outcome`; the summary view carries `tier, is_emergency, retro_due_at, retro_decided_at`.

## `GET/PATCH /api/workspace-settings`
- GET returns `approval_policy` with every default filled in:
  `{ tiers: { routine|normal|high_risk|emergency|strategic: { approver_role: "manager"|"admin", turnaround_hours: int 0..8760, auto_approve: boolean } }, currency_threshold: number, currency: string|null, emergency_retro_hours: int 1..720 }`.
  Defaults: routine/normal manager, high_risk/emergency(retro)/strategic admin; turnaround 24/48/72/0/120 h; auto_approve false everywhere; threshold 50000; retro 48 h.
- PATCH accepts `approval_policy` (any subset; only the rules sent change; unknown keys and tiers are 422; `auto_approve: true` only on `routine`; admin session only). Exactly one `workspace.settings_update` audit row with `before`/`after` holding `approval_policy`.

## `GET /api/integrations/cron`
- The tick summary gains `approvals: { workspaces, examined, reminders, escalated, autoApproved, retroOverdue, failed, skippedForDeadline }`.

## Pending-item shape (for W4-B's `pending.ts`, review queue and approvals page)
Column names on `change_requests`, `deletion_requests`, `rebaselines`: `tier`, `approval_deadline_at`. On `change_requests` only: `is_emergency`, `retro_due_at`, `retro_decided_at`, `retro_outcome`.
- `retro_overdue` is NOT a stored column on purpose (the timer must not write to the request row). Compute it with `isRetroOverdue(row, now)` from `lib/governance/tiers.ts`: `is_emergency && !retro_decided_at && retro_due_at < now`.
- A change request is waiting when `status in (raised, under_review, emergency)` OR `(status = implemented AND is_emergency AND retro_decided_at is null)`. The second branch is the live emergency owing its retro decision.
- Who may decide a row: `roleMeetsTier(viewerRole, row.tier, policy)` (`lib/governance/tiers.ts`); `judgeDecision` in `lib/review/four-eyes.ts` already accepts an optional `policy` and blocks with `needs_admin`. Pass `loadApprovalPolicy(db, workspaceId)` where the page can.

## Notification types (new)
`approval.reminder`, `approval.escalated`, `approval.auto_approved` (payload `{href: "/approvals", targetType, targetId, tier}`).

## Audit actions
- `approval.timer_run` (new; one per workspace per daily run, `after` = counts, actor `system:approval-timer`).
- `change_request.decide` by the actor `system:auto-approve (policy)` (nil-uuid system actor, no principal, `request_id` cron, `after.auto_approved` true) is a routine request approved by policy.
- `change_request.create` rows now carry `tier`, `approval_deadline_at` and, for an emergency, `is_emergency`, `retro_due_at` in `after`.

## Digest, weekly report, audit pack
- Digest data gains `retroOverdue` (live emergency changes past `retro_due_at`); the Lark digest card and the weekly-report notification text add a line only when it is above zero. `pendingApprovals` now also counts status `emergency`.
- Audit-pack change-request CSV (`/api/export?entity=change_requests` and the pack) gains trailing columns `tier, is_emergency, retro_due_at, retro_decided_at, retro_outcome, retro_overdue`.

## Fix pass (review wave 4)
- `approval_policy` gains `schedule_threshold_days` (int 0..3650, default 10): a schedule impact of more than this many days lifts a normal change request to `high_risk`. `currency` is a LABEL only (default `MYR`, or null): every cost is compared as a plain number in the workspace's own currency, nothing is converted and a cost in another currency is no longer bumped.
- Routine: `tier: "routine"` is a 422 when `impact_cost`, `impact_schedule_days` or `impact_scope` is set. The database also raises a routine request that gains any of them to `normal`.
- Fallback approver (owner decision D7): in a workspace with fewer than two admins a manager may decide an admin-level request (403 otherwise). A change request's `change_request.decide` audit row then has `after.fallback_approver: true`; a deletion or rebaseline gets one extra `approval.fallback_approver` audit row. Four-eyes still bars the raiser.
- 403 text for an admin-level refusal: "Only admins can approve a high-risk request." (tier name in words).
- `PATCH` and `DELETE /api/change-requests/{id}` are allowed for the requester while the status is `emergency` (not yet implemented); a live emergency (`implemented`) stays part of the record (422).
- `PATCH /api/workspace-settings` is now one transaction with its audit row (`nopm_update_workspace_settings`) and pinned: if another admin changed the same setting since this admin read it, 412 `precondition_failed`.
- Nav badge counts, chat catch-up and card state treat `emergency` and a live emergency owing its retro decision as pending.
- SQLSTATEs (migrations 0100/0101): P0030 TIER_LOCKED, P0031 AUTO_APPROVE_OFF, P0032 NOT_ROUTINE, P0033 NOT_DUE, P0034 STALE_ROW, P0035 FORBIDDEN_COLUMN. P0040 to P0042 belong to 0102 and P0051 to P0056 to 0103; a test fails if any of mine is used for a second meaning.

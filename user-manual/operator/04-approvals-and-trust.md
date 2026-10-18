# 04 · Approvals and Trust Center

**Status: ACTIVE** · Verified against `web/src/app/(console)/approvals/page.tsx`, `web/src/components/approvals/actions.tsx`, `web/src/app/(console)/trust/page.tsx`, `web/src/app/(console)/review/page.tsx`, `web/src/lib/api/errors.ts`, `web/src/lib/api/rate-limit.ts`, and `web/src/app/api/deletion-requests/**`.

## Four-eyes deletes

Deleting a **task** or a **project** is never a single action. Requesting one (`DELETE /api/tasks/[id]` or `DELETE /api/projects/[id]`) does not delete anything — it snapshots the target row and inserts a `deletion_requests` row (status `pending`), returning `202 Accepted`. An admin or a manager (a different person from the requester) must separately approve it before the delete actually commits.

**The core rules, enforced at the API layer and again in the database:**

- **Who may approve.** Only admins and managers can approve or reject, on every channel: the web, the API, the CLI and chat. A member or viewer sees no Approve or Reject buttons, and a direct call answers `403` "Only managers and admins can approve" (code `role_not_permitted`). This is the same rule Lark has always applied to cards.
- **A different person.** The approver must be a different person from the requester. Self-approval and self-rejection both return `403`/`422` — you cannot decide your own request, even with a second login or a token you created (a token counts as the person who created it).
- **Tokens follow their creator.** A token with an approve scope approves only while the person who created it is an admin or manager. If they are demoted, their tokens stop approving at once.

If the pending request is yours, the Approvals page offers only **Withdraw** (`POST /api/deletion-requests/[id]/withdraw`) instead of Approve/Reject — since four-eyes would just reject your own decision anyway. Withdrawing is terminal: a withdrawn request can't be withdrawn again, but the same target can be re-requested for deletion afterward.

Milestones, risks, and issues are hard-deleted with an audit row only — they do **not** go through this maker-checker flow. That asymmetry is intentional and documented in `docs/SECURITY.md`; only task and project deletion carry the four-eyes gate as of this build.

## Where you approve/reject

`/approvals` lists every **pending** deletion request, showing target type, a shortened target id, who requested it, their stated reason, and when. Approve accepts an optional note; Reject requires a reason. For a project deletion, the row shows how many tasks, milestones, risks, issues, change requests, decisions and documents will be deleted with it, and the audit trail records each of those children separately once the deletion is approved. Both routes are governed the same way — approve commits the delete via a DB RPC, reject just closes the request out.

`/review` (Review Queue) is the broader "everything waiting on a human" surface — it includes pending deletion requests, but also pending rebaseline sign-offs, change requests in review, high/critical risks, unresolved clashes, and documents in review, priority-sorted in one place. Use `/approvals` when you specifically want the deletion queue; use `/review` for the fuller picture.

## Trust Center — audit stream

`/trust` is the workspace-wide, append-only provenance timeline: the newest 50 rows of `audit_log`, each showing the action (e.g. `task.create`, `deletion_request.approve`, `project.delete`), the actor (a human `user` or a scoped `token`), the target, and both a relative and absolute timestamp. The action string is color-coded by verb (create=accent, approve=success, reject=warning, delete/revoke=danger).

Every mutation in NoPM writes exactly one audit row — including drag-to-move on the Kanban board (see [`02-projects-and-tasks.md`](../operator/02-projects-and-tasks.md)) and every deletion-request lifecycle transition (create/approve/reject/withdraw).

A filter bar above the timeline narrows it by channel, action, or (via `?target_type=&target_id=`) a single object — every task, risk, issue, and project detail view carries a "History" link that jumps straight into its own filtered slice, and the CSV export always mirrors whatever filter is active on screen. A "What this proves" card states the four claims a governance reviewer usually asks about up front: retention (rows are kept for the workspace's life and can't be updated or deleted, enforced by database triggers on every role), provenance (actor, declared channel, and request id on every row), fail-closed honesty (deletion and invite commits write their audit row in the same transaction as the change; other writes persist first and error out if the audit row can't be written), and that the export itself is audited.

## Blocked-attempt rows

Not every audit row records a successful write. Two categories of **rejected** attempt are also audited, fail-soft (a broken audit write never masks the rejection itself, nor lets the mutation through):

- **Lock-blocked writes** — e.g. `task.update.blocked`, `task.create.blocked`, `task.delete_request.blocked` — written when a caller tries to change a locked project's schedule shape (see [`03-schedule-and-lock.md`](03-schedule-and-lock.md)).
- **Rate-limited requests** — `rate.limited` — written when a caller exceeds their request budget (see below).

These rows exist so a pattern of denied attempts is visible in the same stream as everything else — an adversarial signal, not a silent gap.

## What a 429 means

NoPM rate-limits authenticated traffic, keyed on workspace + actor class (user vs token) + read/write bucket — a DB-backed fixed window, not per-token (agent tools mint a fresh ephemeral token per turn, so per-token keying would be a no-op). Hitting the limit returns `429` with error code `rate_limited` and a `Retry-After` header saying how many seconds to wait. The limiter fails **open** (never blocks traffic) if its own infrastructure errors, but fails **closed and loud** on an actual limit hit — you'll see a real `429`, not a silent drop, and the attempt is logged as `rate.limited` in the Trust Center.

## Other approvals

The same rule (admins and managers only, never the person who raised it) applies to the other decisions that arrive in `/review`:

- **Change requests:** approve, reject or defer, with a rationale (UC-10).
- **Rebaselines:** sign off go or no go, then apply (on `/baselines`, see [`03-schedule-and-lock.md`](03-schedule-and-lock.md)).

If you see "Only managers and admins can approve", ask an admin or manager to take the decision; nothing was changed.

## Where to go next

- Scheduling and lock semantics that produce the `project_locked` blocked-attempt rows above → [`03-schedule-and-lock.md`](03-schedule-and-lock.md)
- Minting/revoking the scoped tokens that show up as `token` actors here → [`admin/01-workspace-admin.md`](../admin/01-workspace-admin.md)

## Update 2026-10-18 - common-pattern answers

- A manager or admin can start a review on a raised change request. A deferred request can be reopened by the requester or a manager or admin.
- Approving or rejecting a change request needs the version you read; if it changed you see "This request changed after you opened it. Reopen it and review the new version." Rejecting (any request) and deferring need a reason.
- A proposer can withdraw a rebaseline that is waiting for sign-off. You cannot propose one until the project dates are locked.
- Project deletion is refused while the project has approved change requests or approved/applied rebaselines.

Source: owner decisions 19 to 25 and the rule "follow the common pattern" (`journeys/COMMON-PATTERN-ANSWERS.md`, ADR 0015, requirements R-120 to R-126).

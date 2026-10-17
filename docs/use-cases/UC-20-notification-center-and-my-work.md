# UC-20 · Notification center and My Work

**Goal:** Give every person a live, in-app signal when something needs their attention, and one landing page that aggregates "what needs me today" across every project they touch.

**Actors:** Team member, Approver (deletion requests pending their approval surface here too).

**Preconditions:** The actor has a signed-in session; at least one governed event has fired that targets them.

**Trigger:** A governed event happens that another actor should know about: a deletion request needs approval, an over-allocation clash was detected, a change decision was recorded, etc.

## Main flow

1. Governed events publish fail-soft notifications (`notify()`, `web/src/lib/notify/publish.ts`) to the relevant recipients — a notification failure never blocks or rolls back the underlying write (fail-soft, unlike the audit log itself which is fail-closed).
2. The header bell (`web/src/components/notifications/bell.tsx`) subscribes to Supabase Realtime for live updates, with an unread-count badge.
3. `GET /notifications` (scope `notification:read`) lists in-app notifications for the actor; `PATCH /notifications/{id}` marks one read/unread; `POST /notifications/read-all` marks all read.
4. `/my-work` is the operator's aggregated landing page: open tasks, risks owned, issues owned, deletion requests pending **your** approval, and a "hot" strip surfacing the most urgent items across all of the above, joined across every project the actor is on.
5. `/my-tasks` is the narrower, flat list: every open task assigned to the actor, joined to its project, sorted by due date — for when you specifically want the task list and nothing else.
6. Rendered email previews (R-27) simulate what an email notification would look like, without ever sending real email (Resend stays demo-mode by constitution).

## Alternate and exception flows

- **Notification publish fails** (e.g. a transient DB error in the notify path) → the triggering write still succeeds; the failure is swallowed, not surfaced to the caller, and not retried automatically `[UNVERIFIED exact retry/logging behavior on notify failure]`.
- **Missing `notification:read`** → `403`.
- **Realtime subscription unavailable** (e.g. under self-hosting without correctly configured replication, see UC-22) → the bell does not error; it stops receiving live updates and falls back to whatever was last fetched.
- **Shared demo login** → per-visitor state (like assistant chats) must never leak across visitors; notifications for the shared demo identity follow the same "nothing persists across visits that shouldn't" discipline documented for other demo-identity-sensitive features.

## Postconditions

- `notification.read`/`notification.read_all` state changes are not separately governance-audited the same way a domain write is `[UNVERIFIED whether these produce audit_log rows or are treated like the ADR-0009 unaudited-preference carve-out]`; they are read-state for the recipient, not a workspace-visible record.
- The underlying governed event (deletion request, clash, change decision, etc.) still has its own full audit trail regardless of whether the notification was ever read.

## Reporting and evidence

- My Work's "hot" strip is the presentable multi-project surface for this use case: cross-project urgency in one place instead of checking each project individually.
- The Trust Center remains the authoritative record of what actually happened; the notification center is a convenience layer on top of it, not a replacement for it.

## Traceability

- R-IDs: R-27 (Realtime notification bell + email demo-previews), R-37 (Notification center — in-app bell + My Work hub, fed from governed events), R-41 (cross-project My Tasks).
- Key files: `web/src/lib/notify/publish.ts`, `web/src/app/api/notifications/route.ts`, `web/src/app/api/notifications/[id]/route.ts`, `web/src/app/api/notifications/read-all/route.ts`, `web/src/components/notifications/bell.tsx`, `web/src/app/(console)/my-work/page.tsx`, `web/src/app/(console)/my-tasks/page.tsx`.
- Tests: `[UNVERIFIED]` no notification-specific test file was read directly in this pass.

## Open questions

- `[UNVERIFIED]` Whether reading/marking a notification writes its own `audit_log` row or is treated as unaudited per-user state like the ADR 0009 preference carve-out.
- `[UNVERIFIED]` Retry/logging behavior when a `notify()` call itself fails.

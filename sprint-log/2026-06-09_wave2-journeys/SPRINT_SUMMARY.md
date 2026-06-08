# Sprint — Wave 2: persona journeys + notifications (2026-06-09)

**Intent:** stitch the SME "what's hot → where to act" entry point and the governed notification loop. 3-agent AI-assisted wave + integration.

## Done
- **Notification system:** `src/lib/notify/publish.ts` — fail-soft `notify()` (best-effort, never throws into a mutation, unlike audit) + `resolveWorkspaceApprovers` / `resolveProjectOwner`. API: `GET /api/notifications` (session-user, `?unread`, paginated), `PATCH /api/notifications/[id]` (mark-read), `POST /api/notifications/read-all`.
- **Wired into governed events** (alongside, never replacing, `writeAudit`): delete-requested → approvers (`approval.requested`); approve/reject → original requester; risk create high|critical → project owner (`risk.escalated`); over-allocation clash → approvers (`clash.detected`). `detectOverAllocation` now returns boolean.
- **Notification bell** in the header (unread badge, desktop popover / mobile sheet, mark-read on click → routes to `payload.href`, mark-all-read, focus refresh).
- **SME "My Work" hub** (`/my-work`, first nav item): tasks assigned to me, my open risks/issues, approvals awaiting me (pending deletion_requests where requester ≠ me), and a **Hot now** strip (overdue + high/critical). Each row links to the record.
- **Demo data:** 3 seeded notifications + the seeded pending approval so the bell + My Work render populated.

## Verification
- `tsc` clean · `vitest` 34/34 · deployed READY · live DOM check: `/my-work` renders the hub + Hot-now strip with international data.

## Next
- Wave 3: BYOK governed AI assistant (your model drives NoPM's API under scopes + audit + maker-checker).

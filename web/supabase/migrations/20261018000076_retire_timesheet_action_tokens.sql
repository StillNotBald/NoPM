-- Integration review F10 (2026-10-17 night). Hour logging was removed (owner
-- decision 18), so the approval kind 'timesheet' is no longer handled by the
-- integration hub. A timesheet approval card sent before the removal still
-- carries live Approve / Reject buttons for up to 7 days (the action-token
-- lifetime). Tapping one reached the decision code, which refuses the kind.
--
-- Retire those buttons: mark every still-open 'timesheet' action token used,
-- the same way a decided request kills its open tokens. A tap is then a clean
-- "already used" answer instead of a live button that cannot work.
--
-- One-off, idempotent (a second run finds nothing open), data only. No table,
-- column, constraint or trigger changes: the check constraints that still list
-- 'timesheet' are harmless history. superseded_reason is left null (its check
-- only allows 'changed').
-- ROLLBACK: not reversible by design (a retired token is never reopened); the
-- rows keep their approval_kind, so the set that was retired stays identifiable
-- by approval_kind = 'timesheet' and used_at >= the time this ran.

update action_tokens
   set used_at = now()
 where approval_kind = 'timesheet'
   and used_at is null;

# Decisions — 2026-10-17_remove-hour-logging

## Decision 18 — Hour logging removed: hide it, keep data
**Owner, 2026-10-17:** "remove hour logging, not helpful". Chosen option: hide it, keep data.
- Time logging and weekly timesheets (log, submit, approve, reject, reopen, week lock) leave the product on every channel.
- `time_entries` and `timesheet_submissions` and all rows stay; no migration drops or alters them; reversible by git revert.
- Budget actual (and EVM actual cost, variance, burn, rollups) is expenses only. UI label "Actual (expenses)".
- Resources keep people, cost rate, capacity and allocations.
- Existing tokens carrying `time:*` scopes still authenticate; the scopes are inert and no longer granted.

## Decision 17 — moot
Decision 17 (members log only their own hours, R-114) was Claude's extension of decision 16 and was awaiting owner confirmation. The feature is gone, so it needs no confirmation. R-114 is WITHDRAWN.

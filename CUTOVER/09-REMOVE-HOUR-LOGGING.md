# 09 · Remove hour logging (owner decision 18, 2026-10-17)

**Status: deploy-only release. No migrations. Nothing to migrate.**

Owner decision 18, "Hour logging removed: hide it, keep data". Time entries, weekly timesheets, submit / approve / reject / reopen, the week lock and the time report are removed from the console, API, CLI, MCP tools, the assistant and Lark. Budget "actual" is now expenses only.

## What changes in production

- Deploy the build only. `supabase/migrations/` gains no file, so the migration runner has nothing to apply and the live ledger stays as it is.
- The `time_entries` and `timesheet_submissions` tables, their rows, triggers and functions are untouched. Nothing reads or writes them any more (a member with retained timesheet submissions still cannot be deleted, `has_timesheet_records`).
- Existing API tokens that carry `time:*` scopes keep authenticating; the retired scopes are inert. New tokens cannot be minted with them.
- `/time-entries` and `/timesheet-submissions` answer 404. `GET /export?entity=time_entries` is no longer accepted.
- Budget `actual`, variance, burn and EVM actual cost drop the hours x cost-rate part, so numbers that included labor will fall. Tell users before the release.

## Order

1. Build the commit, `npm test`, `npm run rtm:verify`.
2. Deploy (promote the build). No backup or dry-run is needed because no data changes.
3. Smoke: sign in, open the budget of a project that had hours, confirm "Actual (expenses)"; `GET /api/time-entries` is 404; `/review` loads.

## Restore

Revert the removal commit (or the merge) and redeploy. Because the data was never touched, hours and timesheets reappear exactly as they were. There is no data repair step.

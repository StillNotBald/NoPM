# W3-B OpenAPI / llms.txt notes (for the docs agent)

New scope: `report:read` (registered in `web/src/lib/auth/scopes.ts`; the `report:*` wildcard works; not privileged). Add it to the scope list in OpenAPI and llms.txt.

New route: `GET /api/reports/weekly?week=<date|ISO week>` (R-142)
- Scope `report:read`. Workspace-filtered. The success response is `text/html` (not the JSON envelope), with `cache-control: private, no-store`.
- `week`: any calendar day (`2026-10-22`) or an ISO week (`2026-W43`); it resolves to that week's Monday. Omitted = the current week in the workspace time zone.
- It shows the report as it was GENERATED (a stored snapshot), not live figures. 404 when none was generated for that week, 422 when `week` is unreadable, 403 without the scope.
- Contents: workspace name, week, counts (projects, open high risks, pending approvals, stale items), a project table with project codes, milestones due in 14 days, the stalest items.

New route: `POST /api/reports/weekly` ("Send weekly report now")
- Admin or manager SESSION only (403 for member, viewer and every token). No body.
- Refreshes the current week's snapshot, creates a `report.weekly` notification for every admin and manager, writes one `report.weekly.generated` audit row. Response `{ data: { week_start, recipients, report_url } }`. 422 when the workspace has no admin or manager. It does not use the scheduled run's once-a-day slot.

Changed: `GET /api/workspace-settings` response gains `stale_days` (int 1-365, default 14), `nudges_enabled` (bool, default true), `weekly_report_enabled` (bool, default true), `weekly_report_day` (int 1-7, ISO weekday, 1 = Monday, read in `time_zone`).
Changed: `PATCH /api/workspace-settings` (admin session): the body is any non-empty subset of `time_zone`, `stale_days`, `nudges_enabled`, `weekly_report_enabled`, `weekly_report_day`. A bad value gives 422 `Validation failed` with `fields` and nothing is saved. One `workspace.settings_update` audit row whose `before`/`after` hold only the fields that changed; no row when nothing changed.

Changed: `GET /api/audit` gains optional query params (each 422 when malformed): `project_id` (uuid; the project itself plus every record whose audited row names it), `person_id` (uuid; that person's own actions and actions made through a token they own), `kinds` (comma list of `task,risk,issue,change_request,decision,document,project`), `until` (ISO timestamp, exclusive upper bound that pairs with `since`).

Scheduler (`GET /api/integrations/cron`): the summary gains `nudges: { workspaces, staleNudged, weeklyReports, failed, skippedForDeadline }`. The step runs for every workspace, with or without a connector.

Audit glossary: new actions `nudge.sent` (one row per daily batch per workspace; `after` = `{ kind: "stale", stale_days, count, ids[] }`; system actor `system:nudge`) and `report.weekly.generated` (`after` = `{ week_start, trigger: scheduled|manual, recipients }`; system actor `system:weekly-report` when scheduled).

Notifications: new types `item.stale` and `report.weekly` (payload `href`).
Lark digest data: `DigestData` gains `staleItems` and `staleDays`; the weekly digest card gains a "Stale items" line when the count is above zero.
Console route: `/changes` ("What changed").

# UC-28 · Handover and key-person report

**Goal:** Show a project manager or admin what would stall if one person were away. Each project and risk, issue and task can name a backup. The report lists the open work whose single owner has no backup, the work with no owner at all, and the people who are a single point of failure.

**Actors:** Project manager or admin. Any token or session with the report:read scope can read the report through the API, the MCP server or the assistant.

**Preconditions:** Migration 0095 (`backup_owner_id` on projects, risks and issues, `backup_assignee_id` on tasks) is applied before the build serves traffic. The workspace holds projects with open items.

**Trigger:** A leave, a hand-over between projects, or a periodic key-person review.

## Main flow

1. Name a backup on a project, risk, issue or task. Use the Backup owner picker on the project, risk and issue forms, or the Backup assignee picker on the task form. The picker sends the field only when the person changed it, so a form that did not load the stored backup can never clear it.
2. A backup must be a different person from the owner or assignee. The save is refused with a message that names the field.
3. Open **Handover** in the Portfolio section of the navigation. The page shows each project's owners of open items as stacked cards, with counts per owner.
4. Items whose owner has a backup are not listed as at risk. Open items with an owner and no backup appear under that owner. Open items with no owner at all appear under unowned items.
5. Read the key-person matrix. A person who solely owns at least one open item is flagged `bus_factor_1`.
6. Select **Export CSV** to download the same data. Or call `GET /api/reports/handover?format=csv`.

## Alternate and exception flows

- **Project id from another workspace** → `404`. A malformed `project_id` → `422`.
- **Format other than `json` or `csv`** → `422`.
- **A token without `report:read`** → `403`.
- **A backup equal to the owner or assignee** → `422`, with the backup field named in `fields`.
- **A backup from another workspace** → `422` `invalid_reference`.
- **A resource member who is linked to a login** is reported as that login.

## Postconditions

- The JSON read writes no audit row.
- The CSV download writes one `export.csv` audit row with entity `handover`.
- Each create or update of a backup writes its usual audit row, with the backup field in `after`.

## Evidence produced

- The handover report as JSON, or the CSV with a `section` column (`item`, `unowned` or `person`).
- The `export.csv` audit row for each download.
- The `backup_owner_id` and `backup_assignee_id` values on each audited row.

## API calls

- `GET /api/reports/handover` with optional `project_id` and `format=json|csv` (scope `report:read`).
- `POST /api/projects`, `PATCH /api/projects/{id}`, `POST /api/projects/{id}/risks`, `PATCH /api/risks/{id}`, `POST /api/projects/{id}/issues`, `PATCH /api/issues/{id}` accept `backup_owner_id`.
- `POST /api/projects/{id}/tasks`, `PATCH /api/tasks/{id}` accept `backup_assignee_id`.
- MCP and assistant tool `get_handover_report` (optional `project_id`, read only).

## Reporting and evidence

- The report is derived on each read. It is not a stored snapshot, so it always shows the open items as they stand.
- An open item means: project not complete; risk not closed; issue not resolved or closed; task not completed or canceled.
- The project header shows a "No backup owner" badge when a project has no backup.

## Traceability

- R-IDs: R-140 (handover and key-person report, audit gap M6).
- Key files: `web/supabase/migrations/20261018000095_backup_owner.sql`, `web/src/lib/handover/report.ts`, `web/src/app/api/reports/handover/route.ts`, `web/src/app/(console)/handover/page.tsx`, `web/src/components/forms/backup-owner-field.tsx`, `web/src/components/tracking/handover-badge.tsx`.

## Open questions

- The report covers the people who own open items. It does not yet estimate how long a hand-over would take.

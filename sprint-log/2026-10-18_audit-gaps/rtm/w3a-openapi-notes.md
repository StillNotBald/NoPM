# W3-A OpenAPI / llms.txt notes (for the docs agent)

New route: `GET /api/reports/handover` (M6, R-140)
- Description must start `scope: project:read, risk:read, issue:read and task:read.` (it needs all four; the assistant ceiling already holds them).
- Query: `project_id` (uuid, optional; a project in the caller's workspace, else 404; malformed 422), `format` (`json` default, or `csv`; anything else 422).
- JSON response `{ data }`:
  - `generated_for: { project_id | null }`
  - `summary: { projects, open_items, without_backup, unowned, people_bus_factor_1, projects_with_gaps }`
  - `projects[]`: `{ project: { id, code, name }, open_items, without_backup, unowned, owners[], unowned_items[] }`. `owners[]` is `{ person: { key, kind: profile|resource_member, id, label }, counts: { project, risk, issue, task, total }, items[] }`; an item is `{ type: project|risk|issue|task, id, reference, title, status }`. Only open items that have an owner and no backup appear under `owners`; open items with no owner at all appear under `unowned_items`.
  - `key_people[]`: `{ person, sole_items, projects_touched, backup_items, bus_factor_1, sole_projects[] }`. `bus_factor_1` is true when the person solely owns at least one open item. A resource member linked to a login (`resource_members.profile_id`) is reported as that login.
- Open means: project health not `complete`; risk not `closed`; issue not `resolved` or `closed`; task type not `completed` or `canceled`.
- `format=csv`: `text/csv`, one table with a `section` column (`item`, `unowned`, `person`), columns `section, project_code, project_name, item_type, item_reference, item_title, item_status, person, person_id, sole_items, projects_touched, backup_items, bus_factor_1`. Writes one audit row `export.csv` with `after.entity = "handover"`. The JSON read writes no audit row.
- Read-only and derived; every query filters by the caller's workspace.

Changed: `POST /api/projects`, `PATCH /api/projects/{id}`, `POST /api/projects/{id}/risks`, `PATCH /api/risks/{id}`, `POST /api/projects/{id}/issues`, `PATCH /api/issues/{id}`: new optional field `backup_owner_id` (uuid, nullable). Must be a profile in the caller's workspace (422 `invalid_reference`, `fields[0].field = backup_owner_id`); must differ from `owner_id` as sent or as stored (422, field `backup_owner_id`, message "backup_owner_id must be a different person from owner_id"). On PATCH, omitting it leaves it unchanged and null clears it.

Changed: `POST /api/projects/{id}/tasks`, `PATCH /api/tasks/{id}`: new optional field `backup_assignee_id` (uuid, nullable). Must be a resource member (the same kind of id as `assignee_id`) in the caller's workspace; must differ from `assignee_id`; same 422 shapes with field `backup_assignee_id`.

Changed: schemas Project, Risk, Issue gain `backup_owner_id` (uuid, nullable); Task gains `backup_assignee_id` (uuid, nullable). List `fields=` allow-lists (and `view=full`) accept the new columns; the summary views include them. Audit rows for `project.create`, `project.update`, `risk.create`, `risk.update`, `issue.create`, `issue.update`, `task.create`, `task.update` carry them in `after`.

Tool: MCP and assistant `get_handover_report` (optional `project_id`) maps to `GET /api/reports/handover`; add it to the tool table in llms.txt next to `get_evm`.

Release note for the runbook: migration 0095 must be applied before the build serves traffic, because `views.ts` selects the new columns unconditionally on the list and detail routes. The project header badge is the one fail-soft reader (it renders nothing if the column is missing).

## Added with the W3-C tool note

Tool: `list_pending_approvals` gains optional boolean `mine`; when true the tool calls `GET /api/review?mine=1` (the route parameter is documented in `w3c-openapi-notes.md`). Items carry `assigned_to_me` and `assigned_approver_id`. Assignment is routing only and never changes `can_decide`.

Tool: `get_project_trend` (project_id, optional n, default 28, max 120) maps to `GET /api/projects/{id}/trend`, scope `project:read`. Add it to the llms.txt tool table next to `get_evm`.

Tool text: `get_evm` description now explains `forecast_method`, `eac_cpi` and `eac_bottom_up` (no route change).

# OpenAPI and llms.txt wording - W5-D (task blocker and ETA, last sign-in in members export)

Apply in `web/src/app/api/openapi.json/route.ts` and `web/src/app/llms.txt/route.ts` during the docs pass.

## Tasks (R-166)

- Task schema (create body, update body, list item, full row): add two optional nullable properties.
  - `blocker_reason`: string, at most 500 characters, nullable. "Why the task is blocked, in words. Independent of `blocked_by`: either may be set without the other."
  - `eta`: string, format `date` (YYYY-MM-DD), nullable. "Forecast finish date. It is not the baseline, may be in the past, and is not a schedule field, so it can be edited on a locked project like `blocked_by`."
- `GET /api/tasks` and `GET /api/projects/{id}/tasks`: the default (`view=summary`) payload now always includes `blocker_reason` and `eta` (null when unset). `view=full` and `fields=` accept both. Add both to the task summary column list in the lean-payload paragraph.
- `PATCH /api/tasks/{id}`: send `null` to clear either field. A bad `eta` (not a real calendar date) is 422 with `fields`. Audited as `task.update`.
- llms.txt task create and update lines: add `blocker_reason?` (max 500) and `eta?` (YYYY-MM-DD) after `blocked_by?`.

## Members export (R-167)

- `GET /api/export?entity=members`: replace the column list with "id, display_name, email, role, status, mfa_enabled, created_at, removed_at, last_role_change_at, last_role_change_by, and, for an admin session only, last_sign_in_at". Add: "`last_sign_in_at` is the person's last sign-in time from the sign-in service (ISO 8601), empty if they have never signed in. A manager's export has no such column. It is never returned by `GET /api/members`."
- llms.txt export line for `members`: same sentence, one line.

# W2-D OpenAPI + llms.txt notes (for the docs agent)

Three new READ routes. Until `openapi.json/route.ts` documents them, these tests fail:

- `web/src/lib/api/openapi-coverage.test.ts`: "spec documents GET /change-requests", "GET /decisions", "GET /projects/{id}/evm"
- `web/src/lib/assistant/tools-openapi.test.ts`: (a) drift guard and (b) scope containment for `get_evm`, `list_change_requests`, `list_decisions`
- `web/src/lib/api/llms-coverage.test.ts`: the same three paths must appear in `llms.txt`

The existing `GET /change-requests/{id}` and `GET /documents/{id}` are already documented (their tools pass today).

## openapi.json

Operation descriptions must start with `scope: <scope>.` (the cross-check reads it).

1. `GET /change-requests` — "scope: change:read. Workspace-wide list of change requests, newest first. Query: `project_id` (uuid), `status` (raised|under_review|approved|rejected|deferred|implemented), `page`, `limit` (max 100), `view` (summary default | full), `fields` (comma list, allow-list in `src/lib/api/views.ts`; unknown field is 422)." Response `{data: [...], total, page, limit}`; 422 on bad `status`, `project_id`, `view`, `fields`.
2. `GET /decisions` — "scope: decision:read. Workspace-wide list of logged decisions, newest first. Query: `project_id` (uuid), `status` (proposed|accepted|superseded|rejected), `page`, `limit`, `view`, `fields`." Same response shape and 422 rules.
3. `GET /projects/{id}/evm` — "scope: budget:read. Earned-value numbers for one project, computed as the Budget page does." Response `{data: {project_id, currency, as_of_date, schedule_basis: baseline_dates|completion_only, bac, pv, ev, ac, committed, cv, sv, cpi, spi, eac, etc, vac}}`; cpi, spi, eac, etc, vac are null when undefined. 404 for a project outside the workspace.

## llms.txt

One line each for the three routes, in the same style as `GET /projects/{id}/budget`.

## Field note for W2-A

`FULL_COLUMNS.change_requests` in `web/src/lib/api/views.ts` lists today's columns only. When 0092/0093 ship `implemented_at`, `implemented_by`, `decision_id`, `impact_scope`, add them there (and to the summary list if wanted); `view=full` already returns them through `select("*")`, and `get_change_request` passes them through.

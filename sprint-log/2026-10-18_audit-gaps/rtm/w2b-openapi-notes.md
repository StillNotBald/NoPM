# W2-B OpenAPI / llms.txt notes (for the docs agent)

New route: `GET /api/change-requests/{id}/evidence`
- Scope `document:read`. Workspace-filtered. 404 when the change request is not in the caller's workspace.
- Response `{ data: Document[], total, page: 1, limit: 200 }`, ordered by `tested_at` descending (nulls last). Each item: `id, reference_id, title, doc_type, status, version, project_id, change_request_id, evidence_type, evidence_result, tested_by_label, tested_at, evidence_note, external_url, file_name, mime_type, created_at, updated_at`.
- Read-only. Attaching evidence is `POST /api/documents` or `PATCH /api/documents/{id}` (audited as `document.create` / `document.update`).

Changed: `POST /api/documents`, `PATCH /api/documents/{id}` request bodies, and the Document schema (all optional, nullable):
- `change_request_id` uuid. Must be a change request in the caller's workspace and in the SAME project as the document (422 `invalid_reference` if not found in the workspace, 422 `evidence_link_invalid` if the project differs).
- `evidence_type` enum `test_result | uat_signoff | deploy_record | screenshot | other`.
- `evidence_result` enum `pass | fail | partial | n/a`. Needs `evidence_type` (422).
- `tested_by_label` string (1-200). Defaults to the caller's label when evidence is first recorded.
- `tested_at` ISO date-time with offset. Defaults to now when evidence is first recorded.
- `evidence_note` string (max 5000).
- Any evidence field without a change request: 422 code `evidence_needs_change_request`. Setting `change_request_id` to null clears all evidence fields.

Changed: `GET /api/documents` gains query param `change_request_id` (uuid) filter.

Audit: no new action. `document.create` and `document.update` carry `change_request_id` and the evidence fields in `after`.

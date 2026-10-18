# OpenAPI and llms.txt wording - W5-F (attach evidence)

Apply in `web/src/app/api/openapi.json/route.ts` and `web/src/app/llms.txt/route.ts` during the docs pass. This turns the one red test (`attach_evidence` in `tools-mcp-governance.test.ts`) green.

## New operation: `POST /change-requests/{id}/evidence`

Add a `post` next to the existing `get` on `/change-requests/{id}/evidence` (tag `change-requests`, operationId `attachChangeRequestEvidence`, summary "Attach evidence to a change request").

Description (must start with `scope: document:write`):

> scope: document:write. Attaches test, UAT or deploy evidence to a change request. Send `document_id` to link an existing document, or `title` to create a new document filed under the request's project (optional `doc_type` default other, `folder` default General, `summary`, `body`, `external_url`); exactly one of the two. `evidence_type` is required (test_result, uat_signoff, deploy_record, screenshot, other); `evidence_result` (pass, fail, partial, n/a), `tested_by` (stored as tested_by_label; always the acting person: only an admin or manager session may name someone else, otherwise the text is appended to evidence_note as an unverified claim), `tested_at` (ISO 8601, default now) and `evidence_note` are optional. Same write path as POST and PATCH /documents: one audit row, `document.create` (201, new document, status draft) or `document.update` (200, linked document). Workspace-filtered. Linking an existing document is compare-and-set: a document taken by another request meanwhile is 422 evidence_linked_elsewhere. The change request must be raised, under_review, emergency, approved or implemented. An unknown key is a validation error.

Request body (`application/json`, required): object with `document_id` (string uuid), `title` (string, 1 to 500), `doc_type` (the document type enum), `folder` (string, 1 to 100), `summary` (string or null, max 10000), `body` (string or null, max 100000), `external_url` (uri or null, max 2000), `evidence_type` (enum, required), `evidence_result` (enum or null), `tested_by` (string or null, 1 to 200), `tested_at` (date-time or null), `evidence_note` (string or null, max 5000). `additionalProperties: false`.

Responses:

- `201` "The new evidence document" (`Success`), `200` "The linked document" (`Success`).
- `403` missing `document:write`.
- `404` change request or document not found in this workspace.
- `422` validation error with `fields`; or `evidence_not_accepted` (request is rejected or deferred), `evidence_linked_elsewhere` (document is already evidence for another request), `evidence_link_invalid` (document is in a different project than the request).

## Existing GET on the same path

Replace "Read-only: attach evidence with POST /documents or PATCH /documents/{id} (set change_request_id and the evidence fields; audited as document.create or document.update)" with "Attach evidence with POST on this same path, or with POST /documents or PATCH /documents/{id} (set change_request_id and the evidence fields); every route is audited as document.create or document.update."

## llms.txt

- Under change requests add one line: `POST /api/change-requests/{id}/evidence — attach evidence (scope document:write): document_id (link) or title (create), evidence_type, evidence_result?, tested_by?, tested_at?, evidence_note?`.
- MCP tool list: add `attach_evidence`, `implement_change_request`, `list_documents`, `list_rebaselines`, `get_baseline_history`, `list_project_dependencies`; `create_document`, `create_decision` (`change_request_id`) and `create_task` / `update_task` (`blocker_reason`, `eta`) gain fields.

## Lean list wording (only if the documents list route gains `view` / `fields`)

Add `documents` to the lean-payload paragraph and give `GET /documents` the `view` and `fields` parameters like `GET /change-requests`.

## Lean documents list (now built, R-173)

`GET /api/documents` now honours `view` and `fields` like `GET /change-requests`. Add the two parameters (`view` summary|full, `fields` comma list) to the operation and add `documents` to the lean-payload paragraph.

- Default (`view=summary`) columns: id, reference_id, project_id, folder, title, doc_type, status, version, owner_id, file_name, change_request_id, evidence_type, evidence_result, tested_at, created_at, updated_at. No `body`, `summary`, `evidence_note` or `external_url`.
- `view=full` and `fields=` add them back. `body` appears only in `view=full` or when named in `fields`.
- `storage_path` is never returned (before this change the list returned every column including it). `fields=storage_path` is a 422, as is an unknown field or view.
- This is a payload change for existing callers of the list: the CLI `nopm documents` list only uses id, reference_id, title, doc_type, folder, status and created_at, all still present.

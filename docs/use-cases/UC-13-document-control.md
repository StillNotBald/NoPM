# UC-13 · Document control with governed file attachment

**Goal:** Store a project document with folder/version/approval/owner metadata and a real file, safely, with access checked and every step audited.

**Actors:** Project Manager, Team member. AI agent via token with `document:read`/`document:write`.

**Preconditions:** A project exists (documents are typically project-scoped via `?project_id`).

**Trigger:** A charter, plan, or supporting file needs to be tracked as part of the governed record, not emailed around.

## Main flow

1. Create the document record: `POST /api/documents` (scope `document:write`) with folder/version/approval/owner/provenance metadata.
2. Get a signed upload URL: `POST /api/documents/{id}/file/sign` (scope `document:write`) — max 25 MiB, targeting a private Supabase Storage bucket.
3. Upload the file to the signed URL, then attach it: `POST /api/documents/{id}/file` (scope `document:write`) with `path, file_name, mime_type, file_size`.
4. Mime-type hardening (2026-09-07): the declared `mime_type` is normalized (browser-executable types are coerced to `octet-stream`); for inline-rendered types (PDF/image), the declared type is verified against the actual uploaded bytes on attach — a mismatch is rejected `422`. Other types are download-only, never inline-rendered.
5. Read: `GET /api/documents` (`?project_id`, `?doc_type`, `?status` filters), `GET /api/documents/{id}`, and `GET /api/documents/{id}/file` (signed download).
6. Update metadata: `PATCH /api/documents/{id}`. Detach the file without deleting the record: `DELETE /api/documents/{id}/file`. Delete the whole record: `DELETE /api/documents/{id}`.
7. UI: a folder-tree viewer with inline PDF/image preview for the verified-safe mime types.

## Alternate and exception flows

- **Declared mime type doesn't match the actual bytes for an inline-rendered type** → `422` on attach.
- **File exceeds 25 MiB** → the signed-upload step rejects it `[UNVERIFIED exact error shape]`.
- **Missing `document:read`/`document:write`** → `403`/`404` per the usual pattern.
- **A document in `status=in_review`** → automatically surfaces in the Review Queue (`/review`) as a `document` item, oldest first (R-38).
- **Delete** — a document (and its attached file) is a plain hard delete with an audit row only, not maker-checker; four-eyes is reserved for task/project deletion (R-67).

## Postconditions

- `document.create`/`document.update`/`document.delete` audit rows for the record; the file attach/detach/sign steps are audited as part of the same document's action trail `[UNVERIFIED exact action-string granularity for file-level events]`.
- All access (read and write) is workspace-checked before any storage operation runs.

## Reporting and evidence

- The folder-tree viewer is itself the primary "presentable" surface for document control.
- No `entity=documents` value is documented on `GET /api/export`'s entity list `[UNVERIFIED]`.
- "History" deep-link pattern (R-86) applies to documents the same way it does to tasks/risks/issues, linking to `/trust?target_type=document&target_id=<id>` `[UNVERIFIED whether this specific link is wired on the document UI]`.
- Diagram: [`document-control-flow.html`](../processes/document-control-flow.html).

## Update 2026-10-18 - common-pattern answers

- Decisions and documents stay tier B (decision 25). Only a manager or admin marks a decision accepted or superseded (403 `role_not_permitted`: "Only a manager or admin can mark a decision accepted."). A decision created by a member starts as `proposed`; by a manager or admin as `accepted`.
- An accepted or superseded decision cannot be edited or deleted (422 `decision_accepted_locked`: "Decisions cannot be deleted. Record a new decision that replaces this one."). Accepting a decision that supersedes another marks the old one superseded (audit `decision.supersede`); loops are refused (`supersede_loop`).
- A document is approved only by a manager or admin who is not the author (403 `role_not_permitted`, 422 `author_cannot_approve`). It cannot be created approved; approve plus edit in one request is 422 `approve_after_edit`; editing an approved document or its file returns it to draft.

Source: owner decisions 19 to 25 and the rule "follow the common pattern" (`journeys/COMMON-PATTERN-ANSWERS.md`, ADR 0015, requirements R-120 to R-126).

## Traceability

- R-IDs: R-39 (Documents register + real file storage), R-38 (Review Queue `document` kind).
- Key files: `web/src/app/api/documents/route.ts`, `web/src/app/api/documents/[id]/route.ts`, `web/src/app/api/documents/[id]/file/route.ts`, `web/src/app/api/documents/[id]/file/sign/route.ts`, `web/src/app/api/documents/_schema.ts`.
- Tests: document storage path-safety is covered under R-60's governance-invariant vitest suite.

## Open questions

- `[UNVERIFIED]` Exact error shape when a file exceeds the 25 MiB cap.
- `[UNVERIFIED]` Whether the task/risk/issue-style "History" deep-link is wired on the document detail UI specifically.

/** Evidence columns on documents (migration 0094). */
export const DOCUMENT_EVIDENCE_COLUMNS =
  "change_request_id, evidence_type, evidence_result, tested_by_label, tested_at, evidence_note";

/** Columns the Documents register and the project page load; the viewer and form need the evidence ones. */
export const DOCUMENT_REGISTER_COLUMNS =
  "id, workspace_id, project_id, reference_id, folder, title, doc_type, status, version, summary, body, external_url, owner_id, created_by, created_at, updated_at, " +
  DOCUMENT_EVIDENCE_COLUMNS;

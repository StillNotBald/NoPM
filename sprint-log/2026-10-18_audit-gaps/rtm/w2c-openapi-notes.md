# W2-C notes for the docs agent (OpenAPI + llms.txt)

`GET /export` already exists in the spec. Changes to document:

1. `entity` enum gains `change_requests` and `audit_pack`.
2. `change_requests`: scope `change:read` (token or session). Same `from`, `to`, `on=created|updated` params as the other entities. CSV columns:
   `id, ref, project_id, project_code, title, category, status, priority, raised_at, requested_by_label, requested_principal_id, decided_at, decided_by_label, decided_principal_id, decision (approve|reject|defer), decision_note, impact_schedule_days, impact_cost, impact_scope, implemented_at, implemented_by_label, evidence_count, evidence_pass, evidence_fail, evidence_latest_at, linked_decisions`.
   Implemented and evidence columns are blank until recorded.
3. `audit_pack`: admin or manager SESSION only (403 for any token, member, viewer). Params: `from`, `to` (UTC days, inclusive; a change request is included when raised or decided in range), `format=csv|pdf` (default csv; other value is 422). Response `text/csv` (single file, first column `section` = change_requests | evidence | decisions | approvals_audit) or `application/pdf`. Filename `nopm-audit-pack-<date>.csv|pdf`. Audited as `export.audit_pack`. Each section capped at 10,000 rows with a `# TRUNCATED` note row.
4. Audit action `export.audit_pack` is already in the action glossary (W2-C added it).
5. llms.txt one-liner: "Audit pack: GET /api/export?entity=audit_pack&from=&to=&format=csv|pdf - admin/manager session only; every change request in range with approver, evidence, implemented date, plus the change audit trail."

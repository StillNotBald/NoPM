# UC-27 · Audit pack for a date range

**Goal:** Give an admin or manager one governed download for a date range. It holds every change request raised or decided in range, with its approver, its evidence and its implementation date, plus the change audit trail.

**Actors:** Admin or manager, in a signed-in user session. Tokens, members and viewers cannot download the pack.

**Preconditions:** The workspace holds change requests, decisions or evidence for the period. The caller is an admin or manager with a user session.

**Trigger:** An audit, a readiness gate or a periodic review needs the change-control record for a period.

## Main flow

1. Choose the period on the Change control page or the Trust page, using the audit pack button. The period is a pair of UTC days, inclusive.
2. The page calls `GET /api/export?entity=audit_pack&from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv`. The default format is `csv`. Use `format=pdf` for the printable form.
3. The CSV is one file. Its first column, `section`, says which part each row belongs to: `change_requests`, `evidence`, `decisions` or `approvals_audit`.
4. A change request is in the pack when it was raised or decided in the period. Its evidence and decisions come with it.
5. The file downloads as `nopm-audit-pack-<date>.csv` or `nopm-audit-pack-<date>.pdf`. The date in the name is set by the server.

## Alternate and exception flows

- **Caller is a token, member or viewer** → `403`. The pack is for an admin or manager session only.
- **Format other than `csv` or `pdf`** → `422`.
- **A section passes 10,000 rows** → the section stops at the cap, and a `# TRUNCATED` note row marks the cut. Narrow the period and download again.

## Postconditions

- One `export.audit_pack` audit row is written for each download, so taking the pack is itself on the record.

## Evidence produced

- The pack file, with the four sections above.
- The `export.audit_pack` audit row.

## API calls

- `GET /api/export?entity=audit_pack&from=&to=&format=csv|pdf` (session only, scope rules as above).
- Related reads: `GET /api/change-requests` (scope `change:read`), `GET /api/change-requests/{id}/evidence` (scope `document:read`), `GET /api/decisions` (scope `decision:read`).

## Reporting and evidence

- The pack is a point-in-time file. Re-run it for the same period to get the rows as they stand now.
- `[UNVERIFIED]` The layout of the PDF version. The plan calls for an audit-pack section in the report module; the section list in the PDF is not yet read from the code.

## Traceability

- R-IDs: R-138 (audit pack), per the wave-2 plan.
- Key files: `web/src/app/api/export/route.ts`, `web/src/lib/reports/pdf.ts`.

## Open questions

- `[UNVERIFIED]` Whether the PDF carries every CSV section, or a summary of them.

# W4-C2 OpenAPI / llms.txt notes (for the docs agent)

New route (the only one; group-2 conversions change no contract):

- `GET /api/audit/verify` - admin or manager SESSION only (a token of any scope, a member or a viewer gets 403). Optional query `from` (ISO 8601 timestamp; 422 when unparsable): check only rows created at or after it. Returns `{ data: { ok (boolean), checked (integer, rows verified), first_bad_id (uuid|null), first_bad_at (timestamp|null), from (string|null), head_hash (string|null, newest row_hash in the workspace), verified_at (timestamp) } }`. Recomputes the per-workspace audit hash chain (migration 0104). Audited: writes one `audit.verified` row whose `after` is the result. 500 and no audit row when the database call fails.

Changed: the audit CSV export (`GET /api/export?entity=audit`) gains a LAST column `row_hash`. `GET /api/audit` rows (which return `select *`) gain `prev_hash`, `row_hash` and `chain_seq`.

Audit glossary: `audit.verified` (already added to `action-glossary.ts`).

Use-case note: Trust Center shows "Chain verified: n rows, last check <time>" with a "Verify now" button for admins and managers. The hash chain proves rows were not edited, removed from the middle or re-ordered. It does not stop a database owner who recomputes every later hash; keep `head_hash` somewhere the owner cannot write to for that.

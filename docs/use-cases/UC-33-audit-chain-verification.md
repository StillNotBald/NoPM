# UC-33 · Verify the audit hash chain

**Goal:** Show an auditor that the audit log has not been edited, had a row removed from its middle, or been re-ordered. Every audit row is chained to the one before it in its workspace. An admin or manager can check the whole chain, or the part from a date, in one action, and the Trust Center shows the result (audit gaps M1 and tamper evidence, assumption A7).

**Actors:** Admin or manager (runs the check, in the console or with `GET /api/audit/verify` on a session). Auditor (reads the Trust Center result and the export). Token, member and viewer cannot run the check.

**Preconditions:** Migration 0104 is applied before the new build is deployed. It hashes every existing audit row once and holds a lock on the audit log while it runs. Re-running it is safe. Migration 0103, which makes each write and its audit row one transaction, is applied first.

**Trigger:** A review, an audit pack, a handover to an auditor, or a routine check before a report is sent.

## Main flow

1. Open **Trust Center**. The chain line reads "Chain verified: n rows, last check <time>", or "not checked yet" before the first check.
2. Select **Verify now**. The check runs over the workspace and the line updates.
3. Read the result. When the chain is intact, the line says so with the row count. When it is not, the line says "Chain broken" and names the first row that does not match.
4. Export the audit pack or the audit CSV. The CSV ends with a `row_hash` column, which an auditor can compare with a later export of the same rows.
5. Record the latest head hash, the newest `row_hash` shown by the check, in a place the database owner cannot write to. That gives a later check something to compare with.

## Alternate and exception flows

- **A token, a member or a viewer calls the check** → `403`. Only an admin or manager session may run it.
- **A `from` value that does not parse** → `422`. Only rows created at or after `from` are checked.
- **The database check fails** → `500`, and no audit row is written for the attempt.
- **A row was edited, removed from the middle, or re-ordered** → the check reports `ok: false`, the first bad row id and its time. The rows from that point on need review before anyone relies on them.
- **A database owner rewrites a row and recomputes every later hash** → the check passes. The chain does not stop this; the external head hash does.

## Postconditions

- Each check writes exactly one `audit.verified` row, with the result in its after. The check is itself in the chain.
- The Trust Center line reflects the most recent check.

## Evidence produced

- The `audit.verified` row for each check, with `ok`, `checked`, `first_bad_id`, `first_bad_at`, `from`, `head_hash` and `verified_at`.
- The audit CSV with the `row_hash` column.

## API calls

- `GET /api/audit/verify` (admin or manager session; optional `from`). Returns `{ data: { ok, checked, first_bad_id, first_bad_at, from, head_hash, verified_at } }`.
- `GET /api/audit` rows carry `prev_hash`, `row_hash` and `chain_seq`.
- `GET /api/export?entity=audit` adds `row_hash` as its last column.

## Reporting and evidence

- The Verify now button is for admins and managers only.
- The chain proves that no row was changed or removed without the change showing up. It does not prove that a database owner did not rewrite the whole chain. That is why the head hash is recorded outside the database.

## Traceability

- R-IDs: R-154 (audit hash chain and verification, A7). Related: R-152 (atomic audited writes, M1), which keeps the change and its audit row in one transaction.
- Key files: `web/supabase/migrations/20261018000104_audit_hash_chain.sql`, `web/src/lib/audit/hash.ts`, `web/src/app/api/audit/verify/route.ts`, `web/src/components/audit/chain-badge.tsx`, `web/src/app/(console)/trust/page.tsx`, `web/src/app/api/export/route.ts`.

## Open questions

- Whether the head hash should be anchored to an external store is a later decision. A7 keeps the chain inside the database for now.

# UC-33 · Verify the audit hash chain, and the external anchor

**Goal:** Show an auditor that the audit log has not been edited, had a row removed from its middle, or been re-ordered. Every audit row is chained to the one before it in its workspace. An admin or manager can check the whole chain, or the part from a date, in one action, and the Trust Center shows the result (audit gaps M1 and tamper evidence, assumption A7).

**Actors:** Admin or manager (runs the check, in the console or with `GET /api/audit/verify` on a session). Auditor (reads the Trust Center result and the export). Token, member and viewer cannot run the check.

**Preconditions:** Migration 0104 is applied before the new build is deployed. It hashes every existing audit row once and holds a lock on the audit log while it runs. Re-running it is safe. Migration 0103, which makes each write and its audit row one transaction, is applied first.

**Trigger:** A review, an audit pack, a handover to an auditor, or a routine check before a report is sent.

## Main flow

1. Open **Trust Center**. The chain line reads "Chain verified: n rows, last check <time>", or "not checked yet" before the first check.
2. Select **Verify now**. The check runs over the workspace and the line updates.
3. Read the result. When the chain is intact, the line says so with the row count. When it is not, the line says "Chain broken" and names the first row that does not match.
4. Export the audit pack or the audit CSV. The CSV ends with a `row_hash` column, which an auditor can compare with a later export of the same rows.
5. Read the anchor card under the chain line. It reads "Anchored <time> (n rows)", "Anchored <time> (n rows), N rows behind" or "Not anchored". A successful check saves the head, including the check's own row, in the second database. The daily job does the same. If you run without a second database, record the head hash in a place the database owner cannot write to.

## Alternate and exception flows

- **A token, a member or a viewer calls the check** → `403`. Only an admin or manager session may run it.
- **A `from` value that does not parse** → `422`. Only rows created at or after `from` are checked.
- **The database check fails** → `500`, and no audit row is written for the attempt.
- **A row was edited, removed from the middle, or re-ordered** → the check reports `ok: false`, the first bad row id and its time. The rows from that point on need review before anyone relies on them.
- **A database owner rewrites a row and recomputes every later hash** → the chain alone passes. The external anchor catches it: the live chain no longer matches the copy in the second database, the state is `mismatch`, and `ok` is false.
- **No second database is set up** → the anchor state is `not_anchored`. The Trust Center says so in one line and says how to turn it on. Nothing else changes.
- **The second database cannot be reached** → the state is `unreachable` (amber in the Trust Center). Writes and the check itself carry on. One `audit.anchor_failed` row is written per streak, and `all_clear` stays false until a comparison succeeds.
- **The chain verified but the anchor shows `mismatch`** → `ok` is false even though `chain_ok` is true. Treat it as an incident and follow `CUTOVER/13-AUDIT-ANCHOR.md`. Nothing is anchored while the state is `mismatch`.

## Postconditions

- Each check writes exactly one `audit.verified` row, with the result in its after, including `chain_ok` and the anchor state before the check. The check is itself in the chain.
- A routine anchor writes no audit row. The first anchor of a workspace and the first success after a failure write `audit.anchored`; a failure streak writes one `audit.anchor_failed`; a mismatch streak writes one `audit.anchor_mismatch`.
- The Trust Center line reflects the most recent check.

## Evidence produced

- The `audit.verified` row for each check, with `ok`, `chain_ok`, `checked`, `first_bad_id`, `first_bad_at`, `from`, `head_hash`, `verified_at` and the anchor state.
- The anchor records in the second database: workspace, chain position, head hash, row count and time. Hashes and counts only.
- The anchor line on the audit pack cover.
- The audit CSV with the `row_hash` column.

## API calls

- `GET /api/audit/verify` (admin or manager session; optional `from`). Returns `{ data: { ok, chain_ok, all_clear, checked, first_seq, limit, first_bad_id, first_bad_at, from, head_hash, verified_at, anchor } }`. `anchor` holds `state` (`not_anchored`, `anchored`, `behind`, `mismatch` or `unreachable`), `chain_seq`, `anchored_at`, `row_count`, `rows_behind` and `since`. No route anchors on demand.
- `GET /api/audit` rows carry `prev_hash`, `row_hash` and `chain_seq`.
- `GET /api/export?entity=audit` adds `row_hash` as its last column.

## Reporting and evidence

- The Verify now button is for admins and managers only.
- The chain proves that no row was changed or removed without the change showing up. On its own it does not prove that a database owner did not rewrite the whole chain. The anchor closes that gap for workspaces where the second database is set up.
- `all_clear` is true only when the chain is sound and the anchor state is neither `mismatch` nor `unreachable`. Never read `anchored` without a check that ran.

## Traceability

- R-IDs: R-154 (audit hash chain and verification, A7), R-168 (anchor the chain head outside the database), R-169 (verify compares with the anchor), R-170 (Trust Center anchor card and loud failure). Related: R-152 and R-161 to R-165 (atomic audited writes, M1), which keep the change and its audit row in one transaction. Decision record: `docs/adr/0018-atomic-audit-and-external-anchor.md`.
- Key files: `web/supabase/migrations/20261018000104_audit_hash_chain.sql`, `web/src/lib/audit/hash.ts`, `web/src/app/api/audit/verify/route.ts`, `web/src/components/audit/chain-badge.tsx`, `web/src/app/(console)/trust/page.tsx`, `web/src/app/api/export/route.ts`.

## Open questions

- None on the anchor. The owner chose a second database (Q8). The anchor database provider (D9) and the failure mode (D8) are built as their recommended defaults until the owner answers: a separate project under a separate login, and fail open for writes with loud claims.

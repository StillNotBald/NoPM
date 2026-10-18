# UC-32 · Deletion by request for risks, issues, expenses, documents and milestones

**Goal:** No governed record disappears because one person pressed delete. Deleting a risk, an issue, an expense, a document or a milestone raises a request with a reason. A different person approves it. Tasks and projects already worked this way; this use case extends the rule to the five record types that were hard deletes before (audit gap G8).

**Actors:** Requester (anyone with the matching `<entity>:delete:request` scope, or an admin or manager in the console). Approver (a different person with the matching `<entity>:delete:approve` scope and an approver role). Admin (the only one who can request deletion of an approved document).

**Preconditions:** Migration 0102 is applied before the new build is deployed, in the same release window. An old build that still calls the old delete route gets an error once the migration is live. The stored deletion requests table has the five new target types.

**Trigger:** A risk is closed by mistake, a duplicate issue is logged, an expense was entered twice, a document was uploaded in the wrong project, or a milestone was made in error.

## Main flow

1. The requester opens the record. On a milestone, the control reads **Request deletion**. A dialog asks for a reason, and it stacks at phone width.
2. The requester enters a reason and submits. The record stays where it is. The milestone shows **Deletion requested** while the request waits.
3. The request appears in **Approvals** and in the review queue, under its own kind (risk, issue, expense, document or milestone deletion). It shows the record name, the project, the requester, the reason, and what approving also detaches. For a milestone, that is its tasks.
4. A different person with the matching approve scope opens the request and approves it, or rejects it.
5. On approval, the record is deleted in the same transaction as the request is committed. The stored file of a document is removed after the commit. A milestone's tasks are unlinked and kept.
6. The requester can cancel their own pending request with withdraw. The approver can reject it.

## Alternate and exception flows

- **The requester is the approver** → refused (four-eyes by person). A token counts as the person who minted it.
- **An approved document, and the requester is not an admin** → refused at request time with `403` `role_not_permitted`, recorded as `document.delete_request.blocked`. Refused again at approval as `422` `approved_document_needs_admin`.
- **A milestone's project is locked** → refused at request time with `422` `project_locked`. A request already waiting is closed at approval.
- **A milestone gained or lost tasks after the request** → approval refused with `422` `children_changed`. The approver must see the new count and raise a new request.
- **A second request for the same record while one waits** → `422` `duplicate_deletion_request`.
- **A direct delete of one of these five tables, outside an approved request** → refused by the database. A seed script that does this fails by design.
- **The record was already gone, for example by a cascade** → the request closes as withdrawn.

## Postconditions

- The request raise writes `<entity>.delete_requested` (for example `risk.delete_requested`) with the reason.
- An approval writes `<entity>.delete` and `deletion_request.approved` in the same transaction.
- A rejection or withdrawal writes its own audit row. Nothing is deleted.

## Evidence produced

- The `deletion_requests` row, with the target type, the reason, the requester, the approver, the outcome, and the tier and approval deadline the workspace policy gives it.
- The two audit rows of an approval, and the blocked rows where a refusal applies.

## API calls

- `DELETE /api/risks/{id}` (scope `risk:delete:request`), `DELETE /api/issues/{id}` (`issue:delete:request`), `DELETE /api/expenses/{id}` (`expense:delete:request`), `DELETE /api/documents/{id}` (`document:delete:request`), `DELETE /api/milestones/{id}` (`milestone:delete:request`). Each takes a `reason` and returns `202` with the request.
- `POST /api/deletion-requests/{id}/approve` and `/reject` (scope `<entity>:delete:approve`), `/withdraw` (scope `<entity>:delete:request`).
- `GET /api/deletion-requests` lists requests of every target type.

## Reporting and evidence

- The Approvals page and `GET /api/review` show waiting requests with what approving also removes.
- The audit log shows every request, approval and refusal, including the blocked attempts.

## Traceability

- R-IDs: R-151 (deletion by request for every governed record, G8). The tier rules for these requests are R-148 in `docs/adr/0017-approval-tiers.md`.
- Key files: `web/supabase/migrations/20261018000102_deletion_by_request_all.sql`, `web/src/lib/governance/request-deletion.ts`, `web/src/lib/governance/deletion-dispatch.ts`, `web/src/components/governance/request-deletion.tsx`, `web/src/app/(console)/approvals/page.tsx`, and the CLI remove commands in `cli/commands/`, which take `--reason`.

## Release note

The seed script `scripts/seed-documents.mjs` deletes documents with the service role. After this release that fails by design. Seed data is removed by request, or the database is recreated.


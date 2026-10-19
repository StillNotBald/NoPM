# UC-35 · Deletion by request for programs, sprints, resource members, allocations and clashes

**Goal:** Close the last hard deletes. Deleting a program, a sprint, a resource member, an allocation or a clash now raises a request with a reason. A different person approves it. Together with UC-12 (tasks and projects) and UC-32 (risks, issues, expenses, documents, milestones), every governed record is removed by two people (audit gap G8).

**Actors:** Requester (anyone with the matching `<entity>:delete:request` scope, or an admin or manager in the console). Approver (a different person with an approver role and the approve scope: `project:delete:approve` for a program, `task:delete:approve` for the other four). Admin (the only approver of a program, which is high risk).

**Preconditions:** Migration 0113 is applied before the new build is deployed. Migration 0114, which makes the database refuse a direct delete on the five tables, is applied after the new build is serving. Between the two files the old and the new build both work.

**Trigger:** A program was made twice, a planned sprint is no longer needed, a person left and their resource record must go, an allocation was entered against the wrong project, or a clash was logged in error.

## Main flow

1. The requester opens the register and selects **Request deletion** on the row. A dialog asks for a reason. It stacks at phone width.
2. The requester submits. The record stays where it is, and the row shows that a deletion is requested.
3. The request appears in **Approvals** (Mine and Waiting) and in the review queue under its own kind: program, sprint, resource, allocation or clash deletion. It shows the record, the requester, the reason, and what approving also removes.
4. A different person with the approve scope approves it, or rejects it.
5. On approval the record is deleted in the same transaction that commits the request. The audit entry lists anything that went with it.
6. The requester can withdraw their own pending request. The approver can reject it.

## What each kind does

| Kind | Tier and approver | What the approver sees | Extra rules |
|---|---|---|---|
| Program | High risk, admin only | How many projects the program holds | Approving never deletes the projects. They lose the grouping. |
| Sprint | Normal, manager or admin | How many tasks are attached | Only a planned sprint with no attached tasks. Checked again at approval. |
| Resource member | Normal, manager or admin | Their allocations, with ids, and assigned tasks | Refused while the member has archived timesheets. Approving deletes the allocations with the member and lists their ids in the audit entry. |
| Allocation | Normal, manager or admin | The allocation | The member's over-allocation is checked again after approval. |
| Clash | Normal, manager or admin | The clash | Needed for any clash, including one the system created. Resolving a clash is a status change and does not need a request. |

The tier is fixed by the kind. It is not routable in Settings.

## Alternate and exception flows

- **The requester is the approver** → refused (four-eyes by person). A token counts as the person who minted it.
- **A second request for the same record while one waits** → `422` `duplicate_deletion_request`.
- **A token with no recorded owner** → `403` `no_principal`.
- **A resource member with archived timesheets** → `422` `has_timesheet_records` at request time, and again at approval.
- **A sprint that is not planned, or has attached tasks** → refused at request time. If it was started after the request, approval is refused with `422` `sprint_not_planned`. If tasks were attached, `422` `children_changed`.
- **A program, sprint or resource member whose child count moved after the request** → approval refused with `422` `children_changed`. Raise a new request.
- **A manager tries to approve a program** → `403` `role_not_permitted`. Only an admin approves a high-risk request.
- **A direct delete on one of the five tables, outside an approved request** → refused by the database once 0114 is applied. A seed script that does this fails by design.
- **A token with the old write scope** (for example `sprint:write`) → still allowed to ask. It never gains the right to approve.

## Postconditions

- The raise writes `<entity>.delete_requested` (for example `sprint.delete_requested`) with the reason, in the same transaction as the request.
- An approval writes `<entity>.delete` and `deletion_request.approved` in the same transaction as the delete. A resource deletion's entry lists the cascaded allocation ids.
- A rejection or withdrawal writes its own audit row. Nothing is deleted.
- No chat approval card is sent for these kinds.

## Evidence produced

- The `deletion_requests` row, with target type, reason, requester, approver, outcome, tier and deadline.
- The audit rows of the raise and the decision, and the blocked rows where a refusal applies.

## API calls

- `DELETE /api/programs/{id}` (`program:delete:request`), `DELETE /api/sprints/{id}` (`sprint:delete:request`), `DELETE /api/resources/{id}` (`resource:delete:request`), `DELETE /api/allocations/{id}` (`allocation:delete:request`), `DELETE /api/clashes/{id}` (`clash:delete:request`). Each takes a `reason` and answers **202** with the request. These routes answered 204 with no body before (owner decision D19).
- `POST /api/deletion-requests/{id}/approve` and `/reject`, `/withdraw`. `GET /api/deletion-requests` lists all twelve target types.
- `GET /api/review` shows the five new kinds, each readable with its own read scope or `audit:read`.
- MCP: `request_program_deletion`, `request_sprint_deletion`, `request_resource_deletion`, `request_allocation_deletion`, `request_clash_deletion`, and `withdraw_deletion_request` for every kind.

## Reporting and evidence

- Approvals and `GET /api/review` show waiting requests with what approving also removes.
- The audit log shows every request, approval and refusal.

## Traceability

- R-IDs: R-176 (deletion by request for the five registers), R-177 (the Request deletion controls), R-175 (the MCP tools). The decision record is `docs/adr/0018-atomic-audit-and-external-anchor.md`; the tier rules are R-148 in `docs/adr/0017-approval-tiers.md`.
- Key files: `web/supabase/migrations/20261018000113_deletion_by_request_registers.sql`, `web/supabase/migrations/20261018000114_deletion_refuse_triggers.sql`, `web/src/lib/governance/request-deletion.ts`, `web/src/lib/governance/deletion-dispatch.ts`, `web/src/app/(console)/approvals/page.tsx`.

## Release note

Clients of the five `DELETE` routes must read the new 202 body. The seed scripts that delete from these tables stop working after 0114 by design; remove seed data by request or recreate the database. Release order is in `CUTOVER/14-WAVE5-RELEASE.md`.

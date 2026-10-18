# OpenAPI and llms.txt wording for W5-G (R-176, R-177)

One contract change: the five DELETE operations below answered **204 with no body** and now answer **202 with `{ data: <deletion_requests row> }`** and need a body. Everything else is wording. Wave 3 (W5-H) applies this.

## The five DELETE operations (`deleteProgram`, `deleteSprint`, `deleteResource`, `deleteAllocation`, `deleteClash`)

Replace the existing summary, description, request body and responses of `delete` under `/programs/{id}`, `/sprints/{id}`, `/resources/{id}`, `/allocations/{id}` and `/clashes/{id}`, using the milestone operation (`deleteMilestone`) as the pattern.

- **Summary:** "Request program deletion (maker step)" (and the same for sprint, resource member, allocation, clash).
- **Request body (required):** `{ reason: string (required, max 1000), assigned_approver_id?: uuid | null }`.
- **Responses:** remove `204`. Add `202` "Deletion request created (pending) - { data: deletion_request }" (schema `Success`), `403` "Missing <scope> (forbidden_scope), or no recorded owner (no_principal)", `404` "Not found", `422` as below.
- **The scope line must name the new scope** (the assistant tool test reads the first `scope:` clause and needs one of its scopes in the assistant ceiling):

| Operation | `scope:` clause to write |
|---|---|
| `deleteProgram` | `scope: program:delete:request or program:write (the old scope still works for asking)` |
| `deleteSprint` | `scope: sprint:delete:request or sprint:write` |
| `deleteResource` | `scope: resource:delete:request or resource:write` |
| `deleteAllocation` | `scope: allocation:delete:request or resource:write` |
| `deleteClash` | `scope: clash:delete:request or clash:write` |

- **Description sentences** (after the scope clause, all five): "Does NOT delete the <record> (deletion by request, audit gap G8). Creates a deletion_request (target_type=<program|sprint|resource|allocation|clash>) and returns 202 with it. A different PERSON with an approver role must approve it at POST /deletion-requests/{id}/approve. 422 duplicate_deletion_request if one is already pending. A token with no recorded owner is 403 no_principal. The request and its audit entry (<entity>.delete_requested) are saved together."
- **Program:** add "A program deletion is high risk: only an admin approves it (approve scope project:delete:approve). Approving never deletes the program's projects; they lose the grouping. The request records how many projects the program holds, and approval is refused 422 children_changed if that number has moved."
- **Sprint:** add "422 when the sprint is not planned or has attached tasks (the same rules as before). Approval scope task:delete:approve. Approval is refused 422 sprint_not_planned if the sprint was started meanwhile, and 422 children_changed if tasks were attached."
- **Resource:** add "422 has_timesheet_records while the member has archived timesheets (kept for the record); checked again at approval. The request records the member's allocations; approving deletes them with the member and lists their ids in the audit entry (resource.delete, after.cascade_deleted.allocations). Approval is refused 422 children_changed if the allocation count moved. Approval scope task:delete:approve."
- **Allocation:** add "Approval scope task:delete:approve. When it is approved the member's over-allocation is checked again."
- **Clash:** add "Needed for any clash, including one the system created. Resolving a clash is a status change (PATCH) and is not affected. Approval scope task:delete:approve."

## Other operations

- `GET /deletion-requests`: the `target_type` values are now task, project, risk, issue, expense, document, milestone, program, sprint, resource, allocation, clash.
- `POST /deletion-requests/{id}/approve`: "Scope by kind: ... project:delete:approve for a project or a program, task:delete:approve for a task, sprint, resource, allocation or clash, and the per-record approve scope for the others. Extra 422 codes for the new kinds: has_timesheet_records, sprint_not_planned."
- `GET /review` (the pending list): the `kind` enum gains `program_deletion`, `sprint_deletion`, `resource_deletion`, `allocation_deletion`, `clash_deletion`. Read gating: each is readable with its own read scope (program:read, sprint:read, resource:read for resource and allocation, clash:read) or audit:read; a token without one finds the kind in `hidden_kinds`.
- Scope list in the OpenAPI intro (if it lists scopes): add `program:delete:request`, `sprint:delete:request`, `resource:delete:request`, `allocation:delete:request`, `clash:delete:request` (request scopes, not privileged). No new approve scope exists.

## llms.txt

- In the deletion section: "Programs, sprints, resource members, allocations and clashes are no longer deleted directly. DELETE on them raises a deletion request and answers 202 with the request; a different person approves it. Scopes: program:delete:request, sprint:delete:request, resource:delete:request, allocation:delete:request, clash:delete:request (the old *:write scope still works for asking)."
- Where the approve scopes are listed: "A program is approved with project:delete:approve (high risk, admin); sprint, resource, allocation and clash with task:delete:approve."
- MCP tools: `request_program_deletion`, `request_sprint_deletion`, `request_resource_deletion`, `request_allocation_deletion`, `request_clash_deletion`; `withdraw_deletion_request` works for every kind.

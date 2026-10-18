# W4-B OpenAPI + llms.txt notes (for the docs agent)

Five existing operations change meaning. The intro paragraph of `openapi.json/route.ts` (around lines 77-82) and the `DELETE /projects/{id}` description (around line 921) say that milestones, risks and issues are single-step hard deletes. That is no longer true. `llms.txt` says it too.

## openapi.json

Operation descriptions start with `scope: <scope>.`

1. `DELETE /risks/{id}`: "scope: risk:delete:request (the older risk:delete is accepted and means the same). Does NOT delete the risk. Raises a deletion request (target_type=risk) and returns 202 with the deletion_request. Body `{ reason (required, max 1000), assigned_approver_id? }`. A different PERSON holding risk:delete:approve and an approver role (admin or manager) must POST /deletion-requests/{id}/approve. 422 duplicate_deletion_request if one is already pending; 403 no_principal for a token with no recorded owner; 404 outside the workspace. Audit: risk.delete_requested now, risk.delete on approval."
2. `DELETE /issues/{id}`: same, scope `issue:delete:request` (older `issue:delete` accepted), target_type=issue.
3. `DELETE /expenses/{id}`: same, scope `expense:delete:request` (new; it used to need budget:write), target_type=expense. An expense is a money record.
4. `DELETE /documents/{id}`: same, scope `document:delete:request` (new; it used to need document:write), target_type=document. Extra rule: an APPROVED document can be requested only by an admin (403 role_not_permitted; recorded as document.delete_request.blocked). On approval the stored file is removed too.
5. `DELETE /milestones/{id}`: same, scope `milestone:delete:request` (new; it used to need milestone:write), target_type=milestone. 422 project_locked while the project is locked (recorded as milestone.delete_request.blocked). The request records how many tasks the milestone holds (before.child_counts.tasks); approval is refused with 422 children_changed if that number moved. Approving unlinks the tasks (they are kept).
6. Response for all five: 202 `{ data: deletion_request }` (was 204 No Content). Add 202 to each operation and remove 204.

`POST /deletion-requests/{id}/approve` (and reject, withdraw): the scope line becomes "task:delete:approve for target_type=task, project:delete:approve for project, risk:delete:approve, issue:delete:approve, expense:delete:approve, document:delete:approve, milestone:delete:approve for the others". Reject uses the same approve scope. Withdraw uses `<entity>:delete:request` (or the older risk:delete / issue:delete). Extra error codes on approve: `approved_document_needs_admin` (422, a document that was approved and whose requester is not an admin), `children_changed` (422, milestone task count moved), `project_locked` (422, closes the request), `target_gone` (422, closes the request).

`GET /deletion-requests`: `target_type` can now be risk, issue, expense, document or milestone. The list still needs task:read or audit:read.

`GET /review` (and `GET /approvals/pending`): the `kind` enum gains `risk_deletion`, `issue_deletion`, `expense_deletion`, `document_deletion`, `milestone_deletion`. Each item gains `removes: [{label, count, governed}]` (what approving also detaches: a milestone's tasks, a project's records; empty otherwise) and the nullable `tier`, `approval_deadline_at`, `retro_due_at`, `retro_overdue`. Read scopes per kind: risk:read, issue:read, budget:read, document:read, milestone:read (each also satisfied by audit:read). Decide scopes as above.

Scopes registry text: new request scopes `risk:delete:request`, `issue:delete:request`, `expense:delete:request`, `document:delete:request`, `milestone:delete:request`; new privileged approve scopes `risk|issue|expense|document|milestone:delete:approve` (wildcards never grant them; the agent preset holds none of the delete scopes).

## llms.txt

Replace the wording that says milestones, risks and issues are hard deletes. State that every governed record is deleted by request, list the five DELETE routes as the maker step (202, reason required), and add the five new kinds to the `GET /review` kind list.

## Tests that fail until this is applied

`web/src/lib/api/openapi-coverage.test.ts` and `web/src/lib/api/llms-coverage.test.ts` (whatever they assert for the five operations and the scope registry), and `web/src/lib/assistant/tools-openapi.test.ts` if it cross-checks scopes.

## Tool changes (applied to `web/mcp/tools.mjs` and `web/src/lib/assistant/tools.ts`)

- Five new tools `request_risk_deletion`, `request_issue_deletion`, `request_expense_deletion`, `request_document_deletion`, `request_milestone_deletion` (DELETE `/risks|issues|expenses|documents|milestones/{id}`, body `{reason, assigned_approver_id?}`). `tools-openapi.test.ts` scope containment fails for expenses and documents until the spec says the scope is `expense:delete:request` and `document:delete:request` (it still says budget:write and document:write). Risks, issues and milestones pass today only because of the old scopes.
- `create_change_request` gains `tier` (routine, normal, high_risk, strategic) and `is_emergency`; the `status` filter of `list_change_requests` gains `emergency`. The spec's request body and status enum must match.
- `list_pending_approvals` kind enum has the five new `*_deletion` kinds; items carry `removes`, `tier`, `approval_deadline_at`, `is_emergency`, `retro_due_at`, `retro_overdue` (computed, null when not an emergency change).
- The assistant ceiling `TOOL_SCOPES` gains the five `<entity>:delete:request` scopes and no approve scope.

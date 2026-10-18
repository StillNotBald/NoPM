# W4-B note for `web/mcp/tools.mjs` (the lead applies this)

`web/src/lib/review/tool.test.ts` ("kind enum equals the API's PENDING_KINDS exactly") fails until `PENDING_APPROVAL_KINDS` (around line 49) lists the new kinds. `PENDING_KINDS` in `web/src/lib/review/pending.ts` is the source of truth; its order is:

```js
export const PENDING_APPROVAL_KINDS = [
  "task_deletion",
  "project_deletion",
  "risk_deletion",
  "issue_deletion",
  "expense_deletion",
  "document_deletion",
  "milestone_deletion",
  "change_request",
  "rebaseline",
];
```

Update the `list_pending_approvals` description sentence that names the kinds, and say that each item now carries `removes` and the nullable tier fields.

## New tools (same shape as `request_task_deletion`, around line 448)

`DELETE /api/<entity>/{id}` with body `{ reason }` now raises a deletion request for five more records. Add five tools, each `method: "DELETE"`, path `/api/<plural>/${id}`, body `{ reason, assigned_approver_id? }`, `reason` required, with a description ending "Does not delete: a different person must approve it (four-eyes). The agent preset never holds this scope.":

| tool | path | scope |
|---|---|---|
| `request_risk_deletion` | `/api/risks/{id}` | `risk:delete:request` |
| `request_issue_deletion` | `/api/issues/{id}` | `issue:delete:request` |
| `request_expense_deletion` | `/api/expenses/{id}` | `expense:delete:request` |
| `request_document_deletion` | `/api/documents/{id}` | `document:delete:request` (an approved document: admin only) |
| `request_milestone_deletion` | `/api/milestones/{id}` | `milestone:delete:request` |

`withdraw_deletion_request` (around line 471) already works for all of them. If `tools-openapi.test.ts` cross-checks every tool against the spec, apply the OpenAPI notes first.

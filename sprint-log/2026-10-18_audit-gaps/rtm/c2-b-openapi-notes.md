# OpenAPI and llms.txt wording - cycle 2 builder B (tier engine)

Apply these in `web/src/app/api/openapi.json/route.ts` and `web/src/app/llms.txt/route.ts` during the docs pass.

## Emergency (Q1)

- `POST /api/projects/{id}/change-requests`, field `is_emergency`: replace the text about an admin owing a retro decision within the retro window with: "Emergency flag. A manager or admin raises it and it commits at once: the request is stored as `approved` with `tier` `emergency` and `is_emergency` true. It needs no approver and no retro decision, and it has no approval deadline. The raise writes the normal `change_request.create` audit row and a `change_request.emergency_commit` row, with the raiser as the actor. A member gets 403 `role_not_permitted`."
- Change request schema: `tier` enum is unchanged. `status` is no longer `emergency` on new rows (old rows were moved to `approved`; keep the value in the filter enum for history). `retro_due_at`, `retro_decided_at` and `retro_outcome` are deprecated: `retro_due_at` is null for every new emergency, `retro_decided_at` is set to the raise time, and `retro_outcome` is `not_required` (new) or `retired` (closed out by migration 0106), besides the old `approved`, `rejected`, `deferred`.
- The approve, reject and defer endpoints for change requests (and the matching chat paths): an emergency request answers 422 `already_decided`, since nobody decides it.
- `GET /api/review` and the `list_pending_approvals` tool: `retro_overdue` is deprecated and always `false`. An emergency change never appears as waiting. `tier` is `emergency` on change requests that carry the flag.
- Remove the sentences in `llms.txt` and the OpenAPI descriptions that say an emergency change stays flagged until an admin approves it, and that an overdue retro is shown in the queue, the digest and the weekly report.
- `approval.timer_run` audit row: `retroOverdue` is always 0. The `retro_overdue` approval event kind is no longer written.
- Settings field `approval_policy.emergency_retro_hours`: still accepted and stored, but it no longer has any effect. Mark it deprecated.

## Approved documents (Q4)

- `DELETE /api/documents/{id}`: remove "An APPROVED document can be requested only by an admin ... recorded as document.delete_request.blocked" (openapi route near line 2505 and the same sentence in `llms.txt`). New text: "An approved document is on the manager tier like any other document: any caller with `document:delete:request` may request its deletion and a manager or admin other than the requester approves it. The request is audited (`document.delete_requested`, `deletion_request.approved`)."
- The deletion approve endpoint: remove the error code `approved_document_needs_admin` and the 403 about an approved document needing an admin approver.
- Audit glossary: `document.delete_request.blocked` no longer exists.

## Expense deletion (Q5)

- `DELETE /api/expenses/{id}`: add "The request is `normal` tier (a manager approves). When the absolute amount is at or above the workspace `currency_threshold` (default 50,000) it is `high_risk` and only an admin approves it, as for a project. The tier is in the `tier` field of the 202 response."
- `deletion_request` schema `tier`: note that an expense deletion can be `high_risk`.
- New audit actions: `deletion_request.tier_raised` and `change_request.retro_retired` (written by migration 0106) and `change_request.emergency_commit` (written on an emergency raise).

## Error text (W4-32)

- A role refusal (403 `role_not_permitted`) on a decision now names the tier's role: "Only admins can approve a high-risk request." and "Only admins can approve an emergency request." instead of "Only managers and admins can approve".

# W4-A tools note (for the lead to apply to `web/mcp/tools.mjs` and `web/src/lib/assistant/tools.ts`)

1. `create_change_request`: add two optional inputs, both passed through to `POST /api/projects/:id/change-requests`.
   - `tier`: enum `routine | normal | high_risk | strategic`. Description: "Approval tier. Leave out for normal. routine only with no cost and no schedule impact. The server raises it (a cost at or over the workspace threshold makes it high_risk) and never lowers it. strategic needs an admin."
   - `is_emergency`: boolean. Description: "Emergency path: the change can be implemented at once and an admin owes an approval within the workspace window (default 48 h). Only a manager or admin may use it; it stays flagged until approved."
   No approve or decide scope is gained by either field.
2. `list_pending_approvals` / `GET /api/review` items: once W4-B's pending-item work lands, document `tier`, `approval_deadline_at`, `is_emergency`, `retro_due_at`, `retro_overdue` in the tool description (names in `rtm/w4a-openapi-notes.md`).
3. `get_change_request` / `list_change_requests` (W2-D): the new columns `tier, approval_deadline_at, is_emergency, retro_due_at, retro_decided_at, retro_outcome` are in the API's allow-list already (`lib/api/views.ts`); add them to the tool's documented fields.
4. The status enum of `list_change_requests` gains `emergency`.

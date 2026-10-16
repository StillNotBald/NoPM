# UC-12 · Task/project deletion via four-eyes approval

**Goal:** Delete a task or a project only after a second, different person reviews and approves the request, so the most destructive actions in the system can never be a single click (or a single agent call).

**Actors:** Requester / maker (any actor with the matching `:delete:request` scope), Approver / checker (a **different** person holding the matching `:delete:approve` scope; a token counts as the person who minted it).

**Preconditions:** The target task or project exists. For project deletion, the project must not be locked at commit time (see below).

**Trigger:** Someone decides a task or project should be permanently removed.

## Main flow

1. **Maker step.** `DELETE /api/tasks/{id}` (scope `task:delete:request`) or `DELETE /api/projects/{id}` (scope `project:delete:request`), body `{ "reason": "<why>" }` **required** — it becomes the audit trail. This does **not** delete the target. It snapshots the row and inserts a `deletion_requests` row (`status=pending`, `target_type=task` or `project`, deduped by a unique-pending-deletion index), and returns `202 Accepted`.
2. UI: the delete action on a task/project always goes through this path — there is no direct hard-delete button for either entity type.
3. CLI: `nopm tasks rm <taskId> --reason "superseded"` (maker). MCP: `request_task_deletion` / `request_project_deletion` tools — the MCP server intentionally exposes only the maker side for both entity types.
4. The pending request appears on `/approvals` (target type, shortened target id, requester, stated reason, when) and in the broader `/review` Review Queue.
5. **Checker step.** A **different** person (in their own session, or with a token they minted), holding the scope matching the request's `target_type` (`task:delete:approve` or `project:delete:approve`), calls `POST /api/deletion-requests/{id}/approve`. The body may carry an optional `{ "note" }`, which is recorded in the audit trail with the approval. The route dispatches by `target_type` to the matching atomic commit RPC — `nopm_commit_task_deletion` or `nopm_commit_project_deletion` (`web/src/lib/governance/deletion-dispatch.ts`) — never a runtime-interpolated function name. On success: the target is deleted, the request moves to `status=committed`, and two audit rows are written in the same transaction: the entity delete (`task.delete`/`project.delete`) and `deletion_request.approved`.

## Alternate and exception flows

- **Self-approval** (the approver is the requester's person, a token included) → `403`.
- **Self-rejection** → `422` (four-eyes binds both decisions, not just approval).
- **Checker rejects instead** → `POST /api/deletion-requests/{id}/reject` (same per-type scope gate as approve); the request closes without deleting anything.
- **Requester wants to cancel their own pending request** → `POST /api/deletion-requests/{id}/withdraw` (scope: the matching `:delete:request` scope) — the maker's one permitted self-act, audited as `deletion_request.withdrawn`. On the Approvals page, if the pending request is yours, the only offered action is **Withdraw**, not Approve/Reject, since a self-decision would just be rejected anyway. Withdrawing is terminal (a withdrawn request can't be withdrawn again), but the same target can be re-requested afterward.
- **Project became locked after the deletion was requested but before it was approved** → the commit RPC checks `is_locked` up front and raises `PROJECT_LOCKED` (errcode `P0010`), mapped to the same `422` the task path uses. Lock state is pre-checked when a **task** deletion is requested: `DELETE /api/tasks/{id}` returns `422` `project_locked` on a locked project. A **project** deletion request is not pre-checked; its lock is checked only at commit time.
- **Milestones, risks, issues** → never enter this flow at all; they are single-step hard deletes with an audit row only (owner-locked scope decision, "Decision 3").

## Postconditions

- Maker step: one `deletion_request.requested`-equivalent row `[UNVERIFIED exact action string]`, request status `pending`.
- Checker approve: `task.delete`/`project.delete` + `deletion_request.approved` (with the optional approver note), written in the same DB transaction (fail-closed honesty — no window where the change exists without its audit record).
- Checker reject: `deletion_request.rejected`.
- Withdraw: `deletion_request.withdrawn`.
- Trust Center's "What this proves" card explicitly calls out that deletion and invite commits write their audit row in the same transaction as the change.

## Reporting and evidence

- `/approvals` — the dedicated pending-deletion queue.
- `/review` — the broader Review Queue including deletion requests alongside rebaselines, change requests, risks, and clashes.
- `GET /api/deletion-requests` (scope `task:read` or `audit:read`) — `?status=pending|approved|rejected|committed|withdrawn`, `?target_type=task|project`.
- `/trust?target_type=task&target_id=<id>` (or `project`) — per-object History deep-link.
- Diagram: [`four-eyes-deletion-flow.html`](../processes/four-eyes-deletion-flow.html) exists today under this exact name in `docs/processes/`.

## Traceability

- R-IDs: R-03 (maker-checker on delete-task, including withdraw), R-67 (project-delete four-eyes extension, "Decision 3").
- Key files: `web/src/app/api/tasks/[id]/route.ts` (DELETE), `web/src/app/api/projects/[id]/route.ts` (DELETE), `web/src/app/api/deletion-requests/[id]/approve/route.ts`, `web/src/app/api/deletion-requests/[id]/reject/route.ts`, `web/src/app/api/deletion-requests/[id]/withdraw/route.ts`, `web/src/lib/governance/deletion-dispatch.ts`, migrations `20260814000032_project_deletion_four_eyes.sql` and the earlier task-deletion migration `0020`.
- Tests: four-eyes self-approval invariant tests under R-60's governance-invariant vitest suite.

## Open questions

- `[UNVERIFIED]` Exact audit action string for the maker (request-creation) step on both task and project deletion.

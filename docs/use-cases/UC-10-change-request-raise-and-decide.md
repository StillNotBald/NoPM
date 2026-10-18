# UC-10 · Change request: raise and decide

**Goal:** Formally propose a change to a project's scope, schedule, or cost, and have a different person than the requester assess and decide it, replacing an email thread with a traceable record.

**Actors:** Project Manager / stakeholder (raises), Approver / second pair of eyes (an admin or manager who decides — must be a different person from the requester). AI agent via token can raise (`change:write`). It cannot decide through the MCP or assistant tool set, and `change:decide` is never in the agent preset (see alternate flows).

**Preconditions:** A project exists.

**Trigger:** Someone wants to change a project's scope, schedule, or cost after the plan is already underway.

## Main flow

1. Raise the change request: `POST /api/projects/{id}/change-requests` (scope `change:write`). Required on create: `title` (1–255 characters). `category` (`scope|schedule|cost|quality|resource|other`, default `scope`), `priority` (`low|medium|high|critical`, default `medium`) and `status` (default `raised`) are optional. A `status` of `approved`, `rejected`, `deferred` or `implemented` returns `422`, as does any value outside the enum; decisions go through step 3. The request captures the requesting actor identity in an actor-typed pair (`requested_by_type`/`requested_by_id`, migration `20260906000043`), not just a legacy profile-id column — so a token or assistant requester is tracked correctly too.
2. Only a change request in `under_review` status shows up in the workspace's **Review Queue** (`/review`) as a `change` item. A request raised with the default `raised` status does not appear there.
3. Decide the request: `POST /api/change-requests/{id}/decision` (scope `change:decide` — split from `change:write` in R-83, a strictly separate privilege) with `{decision: "approve"|"reject"|"defer", rationale}`. The route re-checks the CR is still `status` `raised` or `under_review` before applying a decision.
4. The decision writes `status → approved|rejected|deferred`, `decided_by`, `decided_by_label`, `decided_by_type`, `decided_by_id`, `decided_at`, `decision_rationale`, one `change_request.decide` audit row (before/after), and a fail-soft `change.decided` notification to the requester.
5. Implement the change once it is live: `POST /api/change-requests/{id}/implement` (scope `change:write`, optional body `{note}`). Only an `approved` request can move to `implemented`. The requester, or any admin or manager, may do it. The status move, the stamp and the audit row `change_request.implement` are one transaction. A repeat is `422` `already_implemented`, and the first stamp is kept.
6. Attach evidence to the request, such as a test result, a UAT sign-off or a deploy record, from the evidence panel on the change detail page. The panel reads `GET /api/change-requests/{id}/evidence` (scope `document:read`, newest test first). Evidence is stored as a document linked with `change_request_id`, and its project must match the request's project.

## Alternate and exception flows

- **Decider is the same person as the requester** (a token or assistant counts as the person who minted it) → `403` "Self-approval is not allowed (four-eyes)".
- **CR already decided** (`status` not `raised`/`under_review`) → `422` "Change request already decided (status: …)".
- **Missing `change:write`/`change:decide`** → `403`.
- **Decider is a member or viewer** (or a token whose creator is) → `403` `role_not_permitted`, "Only managers and admins can approve".
- **An agent tries to decide its own raised CR** → not possible through the MCP or assistant tool set. `change:decide` is never in the assistant's scope ceiling or any PAT preset (R-83, asserted in both scope test files). An admin can still mint a token with `change:decide` by exact name, and that token can decide a request only if its owner is a different person from the requester.

## Postconditions

- One `change_request.create`-equivalent audit row on raise (exact action string `[UNVERIFIED]`, inferred by pattern from `change_request.decide`), one `change_request.decide` audit row on decision.
- Trust Center shows both events against the change request as the target.
- The Review Queue drops the item once it leaves `under_review`.

## Reporting and evidence

- `GET /api/projects/{id}/change-requests` (scope `change:read`) lists the register; `GET /change-requests/{id}` fetches one.
- `GET /api/change-requests` (scope `change:read`) lists every request in the workspace, filterable by project and status.
- `GET /api/export?entity=change_requests` (scope `change:read`) exports the register with its decision, impact scope, implementation and evidence columns.
- Diagram: [`change-request-lifecycle-flow.html`](../processes/change-request-lifecycle-flow.html).

## Update 2026-10-17 — journey-audit fixes

- Owner decision 16 ("follow Lark rules", ADR 0014, R-113): approving or deciding is for admins and managers only, on every channel. A member or viewer gets `403` `role_not_permitted` ("Only managers and admins can approve"). A token is judged by the CURRENT role of the person who minted it, so a member cannot approve through a token and a demoted manager's token stops approving at once.
- **Atomic decision.** The decision, its status change and its `change_request.decide` audit row are one database transaction (`nopm_decide_change_request`, migration 0063); a failed audit write can no longer leave a decided request without a trail.
- **Only the requester edits or deletes an open request** (decision 11). Text limits: description and impact summary 10,000 characters (`422`). `CR-` reference numbers come from a counter and are never reused.
- **MCP.** The stdio MCP server can now raise a change request (`create_change_request`). Deciding stays a person's act: there is no MCP or assistant tool that decides one.

## Update 2026-10-18 - common-pattern answers

- A manager or admin can start the review: `POST /api/change-requests/{id}/review` moves a raised request to `under_review` (scope `change:decide`; audit `change_request.start_review`).
- Approve and reject now require `expected_updated_at` (422 `version_required`; 412 if it changed: "This request changed after you opened it. Reopen it and review the new version."). Reject and defer require a rationale (422 `rationale_required`); the approve rationale stays optional.
- Defer is parked, not final (decision 24): the requester or a manager/admin reopens it with `POST /api/change-requests/{id}/reopen` (scope `change:write`; deferred only; audit `change_request.reopen`).
- The same person repeating an identical decision gets "done" with no second audit row; anyone else sees `already_decided`: "Already approved by X."

Source: owner decisions 19 to 25 and the rule "follow the common pattern" (`journeys/COMMON-PATTERN-ANSWERS.md`, ADR 0015, requirements R-120 to R-126).

## Update 2026-10-18 - change-request evidence chain (audit-gap wave 2)

- **Implemented stamp.** `implemented_at`, `implemented_by` (users only), `implemented_by_type`/`implemented_by_id`, `implemented_by_label`, `implemented_principal_id` and `implemented_note` record who put the change live. Migration `20261018000092_change_request_implemented.sql` holds the columns and the check that implementation never precedes the decision.
- **Structured impact scope.** `impact_scope` is an optional list, one entry per area (scope, schedule, cost, quality, resources or compliance), each with a direction and an optional note. It sits beside the free-text impact summary. Editing it on an open request re-issues the approval card.
- **Decision link.** A decision can name the change request it was taken for (`change_request_id`, same workspace and project), and its options can be recorded as structured choices (`options_structured`, at most one chosen). Both are set while the decision is proposed.
- **Evidence.** A document becomes evidence when it is linked to a change request. Its `evidence_type` is `test_result`, `uat_signoff`, `deploy_record`, `screenshot` or `other`, and its `evidence_result` is `pass`, `fail`, `partial` or `n/a`. Evidence fields without a change request are `422` `evidence_needs_change_request`.

## Traceability

- R-IDs: R-07 (Change-control register), R-83 (`change:decide` split + actor-typed four-eyes), R-134 to R-137 (implemented stamp, structured scope, decision link, evidence) per the wave-2 plan.
- Key files (wave 2): `web/src/app/api/change-requests/[id]/implement/route.ts`, `web/src/app/api/change-requests/[id]/evidence/route.ts`, `web/src/app/api/change-requests/route.ts`, `web/src/app/api/decisions/route.ts`, migrations `20261018000092` to `20261018000094`.
- Key files: `web/src/app/api/projects/[id]/change-requests/route.ts`, `web/src/app/api/change-requests/[id]/route.ts`, `web/src/app/api/change-requests/[id]/decision/route.ts`, `web/src/app/api/change-requests/_schema.ts`, migration `20260906000043_change_request_actor_identity.sql`.
- Tests: `web/src/lib/auth/scopes.test.ts` and `web/src/lib/assistant/scopes.test.ts` assert `change:decide` is never on the assistant ceiling or a PAT preset.

## Open questions

- `[UNVERIFIED]` The exact audit action string written on CR creation (assumed `change_request.create` by naming convention, not read directly from the create route).
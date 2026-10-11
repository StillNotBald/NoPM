# UC-10 · Change request: raise and decide

**Goal:** Formally propose a change to a project's scope, schedule, or cost, and have a different person than the requester assess and decide it, replacing an email thread with a traceable record.

**Actors:** Project Manager / stakeholder (raises), Approver / second pair of eyes (decides — must differ from the requester). AI agent via token can raise (`change:write`) but never decide (`change:decide` is never granted to an agent surface).

**Preconditions:** A project exists.

**Trigger:** Someone wants to change a project's scope, schedule, or cost after the plan is already underway.

## Main flow

1. Raise the change request: `POST /api/projects/{id}/change-requests` (scope `change:write`). Required on create: `title`, `category`, `priority` (`low|medium|high|critical`), `status`. The request captures the requesting actor identity in an actor-typed pair (`requested_by_type`/`requested_by_id`, migration `20260906000043`), not just a legacy profile-id column — so a token or assistant requester is tracked correctly too.
2. While under review, the CR shows up in the workspace's **Review Queue** (`/review`) as a `change` item.
3. Decide the request: `POST /api/change-requests/{id}/decision` (scope `change:decide` — split from `change:write` in R-83, a strictly separate privilege) with `{decision: "approve"|"reject"|"defer", rationale}`. The route re-checks the CR is still `status` `raised` or `under_review` before applying a decision.
4. The decision writes `status → approved|rejected|deferred`, `decided_by`, `decided_by_label`, `decided_by_type`, `decided_by_id`, `decided_at`, `decision_rationale`, one `change_request.decide` audit row (before/after), and a fail-soft `change.decided` notification to the requester.

## Alternate and exception flows

- **Decider is the same actor as the requester** — checked twice: the legacy `requested_by` (profile-id) comparison for pre-migration rows/user-only comparisons, and the actor-typed `(requested_by_id, requested_by_type)` comparison so a token or assistant requester can't be self-approved either → `403` "Self-approval is not allowed (four-eyes)" either way.
- **CR already decided** (`status` not `raised`/`under_review`) → `422` "Change request already decided (status: …)".
- **Missing `change:write`/`change:decide`** → `403`.
- **An agent tries to decide its own raised CR** → structurally impossible from the MCP/assistant tool set; `change:decide` is never included in the assistant's scope ceiling or any PAT preset (R-83, asserted in both scope test files).

## Postconditions

- One `change_request.create`-equivalent audit row on raise (exact action string `[UNVERIFIED]`, inferred by pattern from `change_request.decide`), one `change_request.decide` audit row on decision.
- Trust Center shows both events against the change request as the target.
- The Review Queue drops the item once it leaves `raised`/`under_review`.

## Reporting and evidence

- `GET /api/projects/{id}/change-requests` (scope `change:read`) lists the register; `GET /change-requests/{id}` fetches one.
- No `entity=change_requests` value documented on `GET /api/export`'s entity list `[UNVERIFIED]`.
- Diagram: [`change-request-lifecycle-flow.html`](../processes/change-request-lifecycle-flow.html) is planned in this same work item; it did not exist on disk at the time this catalogue was written.

## Traceability

- R-IDs: R-07 (Change-control register), R-83 (`change:decide` split + actor-typed four-eyes).
- Key files: `web/src/app/api/projects/[id]/change-requests/route.ts`, `web/src/app/api/change-requests/[id]/route.ts`, `web/src/app/api/change-requests/[id]/decision/route.ts`, `web/src/app/api/change-requests/_schema.ts`, migration `20260906000043_change_request_actor_identity.sql`.
- Tests: `web/src/lib/auth/scopes.test.ts` and `web/src/lib/assistant/scopes.test.ts` assert `change:decide` is never on the assistant ceiling or a PAT preset.

## Open questions

- `[UNVERIFIED]` The exact audit action string written on CR creation (assumed `change_request.create` by naming convention, not read directly from the create route).
- `[UNVERIFIED]` Whether CR export exists via `GET /api/export`.

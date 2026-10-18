# ADR 0003 — Allocation write emits two audit rows by design

- **Status:** Accepted
- **Date:** 2026-06-08

## Context

The governance constitution mandates "every mutation = exactly one immutable `audit_log` row." A reviewer reading the audit trail may notice that a single `POST /api/allocations` (or `PATCH /api/allocations/[id]`) request sometimes produces **two** `audit_log` rows rather than one.

## Why two rows occur

`POST /api/allocations` and `PATCH /api/allocations/[id]` both call `detectOverAllocation` after writing the allocation row (`web/src/lib/clash/detect.ts`, called from `allocations/route.ts:85` and `allocations/[id]/route.ts:84-87,125`).

When `detectOverAllocation` finds that the new allocation pushes a resource past 100 % capacity, it **upserts a row in the `clashes` table**. That clash upsert is itself a mutation; `writeAudit` fires for it too, producing a second audit row scoped to the `clashes` entity.

The two rows are:
1. `audit_log` row for the `allocations` mutation (actor, before/after allocation_pct).
2. `audit_log` row for the auto-created `clashes` mutation (actor, new clash record).

## Decision

Accept this behavior as correct and keep both rows. Do **not** suppress the second row.

**Rationale:**
1. The constitution says every **mutation** must be audited — a clash upsert is a distinct mutation on a distinct table. Suppressing its audit row would violate the immutability guarantee.
2. The two-row pattern is more auditable than one: a reviewer can trace "allocation X was created → clash Y was auto-generated at the same instant by the same actor," which directly demonstrates the governance thesis.
3. Callers (UI, CLI, agent) that expect exactly one row per user action can filter on `target_type = 'allocations'` to count user-initiated mutations; the cascade row is tagged `target_type = 'clashes'`.

## Consequences

- Any test that counts total `audit_log` rows after a single allocation POST must account for the possibility of 2 rows when over-allocation is triggered.
- The future R-60 governance-invariant test for "1 audit row per mutation" should be scoped to a single non-cascading mutation (e.g., a project update) to avoid a false failure.
- Documentation and the Trust Center UI should note "cascade writes may produce multiple audit rows in a single request" so reviewers interpret the stream correctly.

## Update 2026-10-17 — the code moved; this ADR now matches it

The journey audit (A3-4) found the ADR had drifted. What is true today:

- **Which writes cascade.** Not only POST and PATCH: DELETE on `/api/allocations/{id}` and a PATCH that changes the member (two detector calls: the old member, then the new) also run `detectOverAllocation`, so each can add clash rows.
- **The cascade row is tagged `target_type = 'clash'`** (singular), not `clashes`. Callers that filter user-initiated allocation changes use `target_type = 'allocation'` (or the `allocation.*` actions); the cascade rows carry `clash.auto_detected` and, new, `clash.auto_resolve`.
- **Resolving is audited now.** When the detector closes a clash because the over-allocation is gone, it writes `clash.auto_resolve` (before it was a silent update). A no-op run writes nothing.
- **A clash already in `investigating` counts as open**, so the detector does not raise a duplicate beside it.
- **A detector failure no longer fails the request.** The allocation is saved, the response is 201/200 with `warnings: ["The allocation was saved, but over-allocation detection failed; clashes for this member may be out of date."]`, and the failure is logged. Before, it returned 500 for a change that had been kept.
- **Project deletion** is the other multi-row case: committing it writes one audit row per cascade-deleted child (`change_request.cascade_delete`, `decision.cascade_delete`, `document.cascade_delete`, `rebaseline.cascade_delete`, `rebaseline_signoff.cascade_delete`) inside the same transaction (migration 0064), beside `project.delete` and `deletion_request.approved`.
- Audit rows never cascade away: `audit_log.target_id` is a bare uuid with no foreign key, so deleting a project cannot delete its history.

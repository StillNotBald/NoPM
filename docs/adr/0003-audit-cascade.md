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

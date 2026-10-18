# UC-06 · Clash detection and resolution

**Goal:** Surface a schedule, resource, or dependency conflict automatically (or record one manually) and resolve it, so cross-project contention is visible instead of discovered late.

**Actors:** Project Manager, Resource owner. AI agent via token with `clash:read` / `clash:write` / `resource:write`.

**Preconditions:** For the auto-detected path, at least one resource member with existing allocations exists.

**Trigger A (automatic):** A new allocation pushes a resource member over 100% committed capacity for an overlapping window.

**Trigger B (manual):** Someone notices a schedule or dependency conflict directly and records it.

## Main flow — automatic over-allocation clash

1. `POST /api/allocations` (scope `resource:write`) creates an allocation (`member_id`, optional `project_id`/`task_id`, `allocation_pct` 0-500 or `hours`, `window_start`/`window_end`).
2. After the insert, `detectOverAllocation()` (`web/src/lib/clash/detect.ts`) re-reads the member's allocations and checks for **overlapping windows summing over 100%**. Exactly 100% is fine; only exceeding it clashes. Non-overlapping windows that individually sum over 100% never clash, since they do not overlap in time.
3. If a clash is found and none is already open for that member, a new `clashes` row is inserted (`over_allocation_pct` recorded) and one `clash.auto_detected` audit row is written. If an open clash already exists for that member, the existing row is **updated in place**, not duplicated — still exactly one `clash.auto_detected` audit row for the write.
4. Workspace approvers are notified fail-soft (`notify()`, type `clash.detected`) — a notification failure never blocks or rolls back the allocation write.
5. If a later allocation update drops the member back to ≤100% overlapping load, the open clash is resolved automatically. Note: if the member simply has no allocations left at all, the detector does **not** resolve an existing open clash on that path — this is a pinned, tested behavior (`web/src/lib/clash/detect.test.ts`), not a bug.

## Main flow — manual clash record

1. UI/API: `POST /api/clashes` (scope `clash:write`) with a workspace-scoped `createClashSchema` body; the row gets a human-readable `reference_id` (prefix `CL`) via `nextRefId()`.
2. `PATCH /api/clashes/{id}` (scope `clash:write`) updates status toward resolution.
3. `DELETE /api/clashes/{id}` (scope `clash:write`) is a plain hard delete with an audit row only — not maker-checker.

## Alternate and exception flows

- **Allocation read fails during detection** → `detectOverAllocation` returns `false` without touching the `clashes` table; the allocation write itself still succeeds (detection is best-effort, not transactional with the allocation insert).
- **Missing `resource:write` on allocation, or `clash:write` on manual clash write** → `403`.
- **Invalid clash payload** → `422` with field-level messages.
- **Unresolved clash ages in the Review Queue** — any clash not in `resolved` status surfaces in `/review`, oldest first (R-38).

## Postconditions

- `clash.auto_detected` (system-triggered) or `clash.create`/`clash.update`/`clash.delete` (direct) audit rows.
- `allocation.create`/`allocation.update` audit rows on the allocation side, independent of whether a clash resulted.
- Trust Center shows both the allocation write and any resulting clash write as separate rows.

## Reporting and evidence

- `GET /api/clashes` lists all clashes (scope `clash:read`), paginated.
- `GET /api/export?entity=clashes` (no extra filter params) is a governed CSV export.
- The Mainline portfolio timeline (R-28) and the resources workload chart (`WorkloadChart`, R-68) both give visual context for why a clash occurred (allocated vs capacity, cross-project).

## Update 2026-10-18 - common-pattern answers

- There is one live clash per person and type: a second one is refused 422 `duplicate_clash`; update the existing one.
- A manual resolve is for managers and admins and needs a `resolution`; a clash closed because the cause was fixed still writes an audit row.
- Allocations up to 500% remain allowed (they raise a clash). Unknown fields are refused 422.

Source: owner decisions 19 to 25 and the rule "follow the common pattern" (`journeys/COMMON-PATTERN-ANSWERS.md`, ADR 0015, requirements R-120 to R-126).

## Traceability

- R-IDs: R-15 (Clash register), R-16 (Resource members + allocation; over-allocation auto-surfaces a clash).
- Key files: `web/src/lib/clash/detect.ts`, `web/src/lib/clash/detect.test.ts`, `web/src/app/api/allocations/route.ts`, `web/src/app/api/clashes/route.ts`, `web/src/lib/notify/publish.ts`.
- Tests: `web/src/lib/clash/detect.test.ts` — exactly-100%-is-fine, over-100%-clashes, update-not-duplicate, exactly-one-audit-row-per-path, no-allocations-does-not-auto-resolve, non-overlapping-windows-never-clash, boundary-at-exactly-100%.

## Open questions

None outstanding for the detection engine itself; it was read verbatim from `detect.ts`'s route usage and its own test file's documented behaviors.

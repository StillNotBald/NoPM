import { PreconditionFailedError } from "@/lib/api/errors";

/**
 * Optimistic concurrency control (R-90) for the five entity PATCH routes
 * (projects, tasks, milestones, risks, issues).
 *
 * OPT-IN: a caller that never sends `expected_updated_at` gets today's
 * last-write-wins semantics unchanged — this function is a no-op when the
 * field is absent. A caller that sends it is asserting "I last read this
 * record at timestamp X"; if the row's current `updated_at` no longer
 * matches, the write is rejected (412) instead of silently clobbering
 * whatever changed underneath it.
 *
 * Precision note: Postgres `timestamptz` carries microsecond precision, but
 * a value that has round-tripped through JSON/JS only survives at
 * millisecond precision (`Date.prototype.toISOString()` truncates there).
 * So this accepts either an exact string match (the common case — the
 * caller echoes back exactly what a prior GET/PATCH response gave it) OR
 * equal millisecond epochs via `Date.parse` (a value the caller reconstructed
 * or received from a source that serializes microseconds). A value that
 * fails to parse (malformed `expected_updated_at`, or a `current` that is
 * somehow not a parseable string) is treated as a mismatch, never as a
 * pass — this function only ever fails closed.
 */
export function checkOptimisticConcurrency(
  currentUpdatedAt: unknown,
  expectedUpdatedAt: string | null | undefined,
): void {
  if (expectedUpdatedAt === undefined || expectedUpdatedAt === null) return; // opt-in

  const current = typeof currentUpdatedAt === "string" ? currentUpdatedAt : null;

  if (current !== null && current === expectedUpdatedAt) return; // exact-string fast path

  const currentMs = current !== null ? Date.parse(current) : NaN;
  const expectedMs = Date.parse(expectedUpdatedAt);

  if (!Number.isNaN(currentMs) && !Number.isNaN(expectedMs) && currentMs === expectedMs) {
    return;
  }

  throw new PreconditionFailedError(
    "Record changed since you loaded it",
    current ?? undefined,
  );
}

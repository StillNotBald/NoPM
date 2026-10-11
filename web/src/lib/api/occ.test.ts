import { describe, it, expect } from "vitest";
import { checkOptimisticConcurrency } from "@/lib/api/occ";
import { PreconditionFailedError } from "@/lib/api/errors";

describe("checkOptimisticConcurrency (R-90)", () => {
  it("is a no-op when expected_updated_at is undefined (opt-in, backward compatible)", () => {
    expect(() => checkOptimisticConcurrency("2026-09-07T00:00:00.000Z", undefined)).not.toThrow();
  });

  it("is a no-op when expected_updated_at is null", () => {
    expect(() => checkOptimisticConcurrency("2026-09-07T00:00:00.000Z", null)).not.toThrow();
  });

  it("passes on an exact string match", () => {
    const ts = "2026-09-07T12:34:56.789Z";
    expect(() => checkOptimisticConcurrency(ts, ts)).not.toThrow();
  });

  it("passes when the two timestamps are millisecond-equal despite different microsecond text", () => {
    // Postgres returns microsecond precision; a value round-tripped through
    // JSON only carries milliseconds. Both name the same instant.
    const fromDb = "2026-09-07T12:34:56.789123+00:00";
    const fromClient = "2026-09-07T12:34:56.789Z";
    expect(() => checkOptimisticConcurrency(fromDb, fromClient)).not.toThrow();
  });

  it("throws PreconditionFailedError on a real mismatch", () => {
    const current = "2026-09-07T12:34:56.789Z";
    const expected = "2026-09-07T00:00:00.000Z";
    expect(() => checkOptimisticConcurrency(current, expected)).toThrow(PreconditionFailedError);
  });

  it("echoes the current value on the thrown error", () => {
    const current = "2026-09-07T12:34:56.789Z";
    try {
      checkOptimisticConcurrency(current, "2026-09-07T00:00:00.000Z");
      expect.fail("expected checkOptimisticConcurrency to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PreconditionFailedError);
      expect((err as PreconditionFailedError).currentUpdatedAt).toBe(current);
      expect((err as PreconditionFailedError).status).toBe(412);
    }
  });

  it("throws when expected_updated_at is malformed (fails closed, never a false pass)", () => {
    const current = "2026-09-07T12:34:56.789Z";
    expect(() => checkOptimisticConcurrency(current, "not-a-date")).toThrow(PreconditionFailedError);
  });

  it("throws when currentUpdatedAt is missing/non-string (fails closed)", () => {
    expect(() => checkOptimisticConcurrency(undefined, "2026-09-07T00:00:00.000Z")).toThrow(
      PreconditionFailedError,
    );
    expect(() => checkOptimisticConcurrency(null, "2026-09-07T00:00:00.000Z")).toThrow(
      PreconditionFailedError,
    );
  });

  it("does not include current_updated_at on the error when the current value could not be resolved", () => {
    try {
      checkOptimisticConcurrency(undefined, "2026-09-07T00:00:00.000Z");
      expect.fail("expected checkOptimisticConcurrency to throw");
    } catch (err) {
      expect((err as PreconditionFailedError).currentUpdatedAt).toBeUndefined();
    }
  });
});

import { describe, it, expect } from "vitest";
import { RuleError } from "@/lib/api/errors";
import { dateWithinPeriod, assertWeekUnlocked, isPeriodLockedError } from "./period-lock";

describe("dateWithinPeriod", () => {
  it("true for a date inside the window (inclusive start)", () => {
    expect(dateWithinPeriod("2026-08-17", "2026-08-17", "2026-08-23")).toBe(true);
  });

  it("true for a date inside the window (inclusive end)", () => {
    expect(dateWithinPeriod("2026-08-23", "2026-08-17", "2026-08-23")).toBe(true);
  });

  it("true for a date mid-window", () => {
    expect(dateWithinPeriod("2026-08-20", "2026-08-17", "2026-08-23")).toBe(true);
  });

  it("false for a date just before the window", () => {
    expect(dateWithinPeriod("2026-08-16", "2026-08-17", "2026-08-23")).toBe(false);
  });

  it("false for a date just after the window", () => {
    expect(dateWithinPeriod("2026-08-24", "2026-08-17", "2026-08-23")).toBe(false);
  });
});

/** Minimal fake Supabase query-builder chain: .from().select().eq().eq() -> {data, error}. */
function fakeDb(rows: { period_start: string; period_end: string }[], error: { message: string } | null = null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: async () => ({ data: error ? null : rows, error }),
        }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("assertWeekUnlocked", () => {
  it("does not throw when no approved submission covers the date", async () => {
    const db = fakeDb([]);
    await expect(assertWeekUnlocked(db, "member-1", "2026-08-20")).resolves.toBeUndefined();
  });

  it("does not throw when an approved submission exists for a DIFFERENT week", async () => {
    const db = fakeDb([{ period_start: "2026-08-10", period_end: "2026-08-16" }]);
    await expect(assertWeekUnlocked(db, "member-1", "2026-08-20")).resolves.toBeUndefined();
  });

  it("throws RuleError (422, period_locked) when an approved submission covers the date", async () => {
    const db = fakeDb([{ period_start: "2026-08-17", period_end: "2026-08-23" }]);
    await expect(assertWeekUnlocked(db, "member-1", "2026-08-20")).rejects.toThrow(RuleError);
  });

  it("the thrown error carries the period_locked code and a 422 status", async () => {
    const db = fakeDb([{ period_start: "2026-08-17", period_end: "2026-08-23" }]);
    try {
      await assertWeekUnlocked(db, "member-1", "2026-08-20");
      throw new Error("expected assertWeekUnlocked to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RuleError);
      expect((err as RuleError).status).toBe(422);
      expect((err as RuleError).code).toBe("period_locked");
    }
  });

  it("propagates a raw query error instead of swallowing it", async () => {
    const db = fakeDb([], { message: "connection reset" });
    await expect(assertWeekUnlocked(db, "member-1", "2026-08-20")).rejects.toThrow("connection reset");
  });
});

describe("isPeriodLockedError", () => {
  it("false for null/undefined", () => {
    expect(isPeriodLockedError(null)).toBe(false);
    expect(isPeriodLockedError(undefined)).toBe(false);
  });

  it("true when errcode is P0011", () => {
    expect(isPeriodLockedError({ code: "P0011", message: "some trigger message" })).toBe(true);
  });

  it("true when the message contains the PERIOD_LOCKED marker even without the code", () => {
    expect(isPeriodLockedError({ message: "PERIOD_LOCKED: week is frozen" })).toBe(true);
  });

  it("false for an unrelated error", () => {
    expect(isPeriodLockedError({ code: "23505", message: "duplicate key value" })).toBe(false);
  });
});

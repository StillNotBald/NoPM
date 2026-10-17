import { describe, it, expect } from "vitest";
import { RuleError } from "@/lib/api/errors";
import {
  dateWithinPeriod,
  assertWeekUnlocked,
  isPeriodLockedError,
  isTimesheetLockedError,
  weekLockRuleError,
  weekLockState,
} from "./period-lock";

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

/** Minimal fake Supabase query-builder chain: .from().select().eq().in() -> {data, error}. */
function fakeDb(
  rows: { period_start: string; period_end: string; status?: string; reopened_at?: string | null }[],
  error: { message: string } | null = null,
) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          in: async () => ({ data: error ? null : rows, error }),
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

// ── R1/H2: a sheet UNDER REVIEW freezes its week too ──────────────────────

const WEEK = { period_start: "2026-08-17", period_end: "2026-08-23" };

describe("weekLockState", () => {
  it("approved -> 'approved'", () => {
    expect(weekLockState("2026-08-20", [{ ...WEEK, status: "approved" }])).toBe("approved");
  });

  it("submitted and never reopened -> 'under_review'", () => {
    expect(weekLockState("2026-08-20", [{ ...WEEK, status: "submitted", reopened_at: null }])).toBe("under_review");
  });

  it("submitted but REOPENED -> not frozen (the governed unlock verb leaves the week editable)", () => {
    expect(weekLockState("2026-08-20", [{ ...WEEK, status: "submitted", reopened_at: "2026-08-25T00:00:00Z" }])).toBeNull();
  });

  it("a rejected sheet does not freeze its week", () => {
    expect(weekLockState("2026-08-20", [{ ...WEEK, status: "rejected" }])).toBeNull();
  });

  it("a sheet for a different week does not freeze this one", () => {
    expect(weekLockState("2026-08-30", [{ ...WEEK, status: "submitted" }])).toBeNull();
  });

  it("approved outranks under-review if both ever overlap", () => {
    expect(
      weekLockState("2026-08-20", [
        { ...WEEK, status: "submitted" },
        { ...WEEK, status: "approved" },
      ]),
    ).toBe("approved");
  });
});

describe("assertWeekUnlocked — sheet under review", () => {
  it("throws RuleError 422 timesheet_locked while a submitted sheet covers the date", async () => {
    const db = fakeDb([{ ...WEEK, status: "submitted", reopened_at: null }]);
    try {
      await assertWeekUnlocked(db, "member-1", "2026-08-20");
      throw new Error("expected assertWeekUnlocked to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RuleError);
      expect((err as RuleError).status).toBe(422);
      expect((err as RuleError).code).toBe("timesheet_locked");
    }
  });

  it("an approved sheet keeps its own code (period_locked) — the documented R-76 contract", async () => {
    const db = fakeDb([{ ...WEEK, status: "approved" }]);
    await expect(assertWeekUnlocked(db, "member-1", "2026-08-20")).rejects.toMatchObject({ code: "period_locked" });
  });

  it("does not throw for a reopened sheet (reopen must still allow edits)", async () => {
    const db = fakeDb([{ ...WEEK, status: "submitted", reopened_at: "2026-08-25T00:00:00Z" }]);
    await expect(assertWeekUnlocked(db, "member-1", "2026-08-20")).resolves.toBeUndefined();
  });
});

describe("DB trigger error mapping", () => {
  it("isTimesheetLockedError: errcode P0012 or the TIMESHEET_LOCKED marker", () => {
    expect(isTimesheetLockedError({ code: "P0012", message: "x" })).toBe(true);
    expect(isTimesheetLockedError({ message: "TIMESHEET_LOCKED: frozen" })).toBe(true);
    expect(isTimesheetLockedError({ code: "P0011", message: "PERIOD_LOCKED" })).toBe(false);
    expect(isTimesheetLockedError(null)).toBe(false);
  });

  it("weekLockRuleError maps each trigger error to its own 422 code, and ignores anything else", () => {
    expect(weekLockRuleError({ code: "P0011", message: "PERIOD_LOCKED" })).toMatchObject({ status: 422, code: "period_locked" });
    expect(weekLockRuleError({ code: "P0012", message: "TIMESHEET_LOCKED" })).toMatchObject({ status: 422, code: "timesheet_locked" });
    expect(weekLockRuleError({ code: "23505", message: "duplicate key" })).toBeNull();
    expect(weekLockRuleError(undefined)).toBeNull();
  });
});

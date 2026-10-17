/**
 * The Log time form and the week grid decide "is this week frozen?" with the
 * client-safe mirror in week-lock.ts. The API's own guard
 * (lib/governance/period-lock.ts) is the authority, so these tests pin the two
 * to the same answer for every status / reopen / date combination, and check
 * the copy the lock puts on screen.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { weekLockState, type WeekLockRow } from "@/lib/governance/period-lock";
import {
  WEEK_LOCK_ERROR_CODES,
  WEEK_LOCK_REASON,
  lockForDate,
  lockForWeek,
  type LockSubmission,
} from "./week-lock";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
  usePathname: () => "/timesheets",
  useSearchParams: () => new URLSearchParams(),
}));

import { LogTimeForm } from "./log-time-form";
import { TimesheetSubmitPanel } from "./submit-panel";

const WEEK = { period_start: "2026-10-12", period_end: "2026-10-18" };
const STATUSES = [undefined, null, "submitted", "approved", "rejected"] as const;
const REOPENED = [null, "2026-10-14T09:00:00Z"] as const;
const DATES = ["2026-10-11", "2026-10-12", "2026-10-15", "2026-10-18", "2026-10-19"];

describe("client lock agrees with the API guard", () => {
  it.each(STATUSES.flatMap((status) => REOPENED.map((reopened_at) => ({ status, reopened_at }))))(
    "status=$status reopened_at=$reopened_at",
    ({ status, reopened_at }) => {
      const subs: LockSubmission[] = [{ ...WEEK, status, reopened_at }];
      for (const date of DATES) {
        expect(lockForDate(date, subs)).toBe(weekLockState(date, subs as WeekLockRow[]));
      }
    },
  );

  it("agrees when several submissions overlap (approved outranks under review)", () => {
    const subs: LockSubmission[] = [
      { ...WEEK, status: "submitted", reopened_at: null },
      { period_start: "2026-10-15", period_end: "2026-10-21", status: "approved" },
    ];
    for (const date of [...DATES, "2026-10-20"]) {
      expect(lockForDate(date, subs)).toBe(weekLockState(date, subs as WeekLockRow[]));
    }
  });
});

describe("what freezes a week", () => {
  const week = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];

  it("a submitted sheet awaiting a decision freezes it", () => {
    expect(lockForWeek(week, [{ ...WEEK, status: "submitted" }])).toBe("under_review");
  });

  it("an approved sheet freezes it", () => {
    expect(lockForWeek(week, [{ ...WEEK, status: "approved" }])).toBe("approved");
  });

  it("a reopened sheet is open for amendment", () => {
    expect(lockForWeek(week, [{ ...WEEK, status: "submitted", reopened_at: "2026-10-14T09:00:00Z" }])).toBeNull();
  });

  it("a rejected sheet, or no sheet, leaves the week editable", () => {
    expect(lockForWeek(week, [{ ...WEEK, status: "rejected" }])).toBeNull();
    expect(lockForWeek(week, [])).toBeNull();
  });

  it("a sheet for another week does not freeze this one", () => {
    expect(
      lockForWeek(week, [{ period_start: "2026-10-05", period_end: "2026-10-11", status: "approved" }]),
    ).toBeNull();
  });

  it("names the API's two lock codes", () => {
    expect([...WEEK_LOCK_ERROR_CODES].sort()).toEqual(["period_locked", "timesheet_locked"]);
  });
});

describe("the reasons shown to the user", () => {
  it("are one short line each", () => {
    expect(WEEK_LOCK_REASON.under_review).toBe("Submitted for approval — reopen to edit.");
    expect(WEEK_LOCK_REASON.approved).toBe("Approved — locked. Reopen to edit.");
  });
});

describe("Log time form", () => {
  it("renders enabled with no lock banner until a frozen week is known", () => {
    const markup = renderToStaticMarkup(createElement(LogTimeForm, {}));
    expect(markup).not.toContain("reopen to edit");
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(?:<[^>]+>)*Log time/);
  });
});

describe("Submit panel", () => {
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(TimesheetSubmitPanel, {
        memberId: "m1",
        periodStart: "2026-10-12",
        canWrite: true,
        initialStatus: "submitted",
        ...props,
      }),
    );

  it("a reopened sheet reads as open for amendment, not pending a decision", () => {
    expect(render({ reopened: true })).toContain("Reopened — open for amendment");
    expect(render({ reopened: true })).not.toContain("pending decision");
  });

  it("a submitted sheet that was never reopened still reads as pending", () => {
    expect(render({})).toContain("Submitted — pending decision");
  });
});

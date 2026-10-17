import { describe, expect, it } from "vitest";
import { safeNotificationHref } from "./href";

describe("safeNotificationHref", () => {
  it("redirects retired timesheet routes to /review", () => {
    expect(safeNotificationHref("/timesheets")).toBe("/review");
    expect(safeNotificationHref("/timesheets?week=2026-10-12")).toBe("/review");
    expect(safeNotificationHref("/timesheets/abc#x")).toBe("/review");
  });
  it("keeps live routes and absent hrefs", () => {
    expect(safeNotificationHref("/projects/1")).toBe("/projects/1");
    expect(safeNotificationHref("/timeline")).toBe("/timeline");
    expect(safeNotificationHref(undefined)).toBeUndefined();
  });
});

import { describe, it, expect } from "vitest";
import { parseIssuePageFilters } from "./_params";

const PID = "11111111-1111-4111-8111-111111111111";

describe("parseIssuePageFilters", () => {
  it("passes valid enum members and a UUID through", () => {
    expect(
      parseIssuePageFilters({ status: "in_progress", severity: "critical", priority: "urgent", project_id: PID }),
    ).toEqual({ status: "in_progress", severity: "critical", priority: "urgent", project_id: PID });
  });

  it("ignores a malformed project_id instead of passing it to .eq()", () => {
    expect(parseIssuePageFilters({ project_id: "abc" })).toEqual({});
    expect(parseIssuePageFilters({ project_id: `${PID}' or '1'='1` })).toEqual({});
  });

  it("ignores values outside the enum whitelists (severity vs priority are not interchangeable)", () => {
    expect(parseIssuePageFilters({ status: "done", severity: "urgent", priority: "critical" })).toEqual({});
  });

  it("takes the first of repeated params and trims", () => {
    expect(parseIssuePageFilters({ status: [" open ", "closed"] })).toEqual({ status: "open" });
    expect(parseIssuePageFilters({ status: "  " })).toEqual({});
  });
});

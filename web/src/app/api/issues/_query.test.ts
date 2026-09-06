import { describe, it, expect } from "vitest";
import { parseIssueFilters, applyIssueFilters, ISSUE_SORT_FIELDS } from "./_query";

describe("parseIssueFilters", () => {
  it("returns an empty object with no params", () => {
    expect(parseIssueFilters(new URLSearchParams())).toEqual({});
  });

  it("extracts status, severity, and priority", () => {
    const params = new URLSearchParams({ status: "open", severity: "high", priority: "urgent" });
    expect(parseIssueFilters(params)).toEqual({ status: "open", severity: "high", priority: "urgent" });
  });

  it("extracts source and external_ref (complement seam, R-81)", () => {
    const params = new URLSearchParams({ source: "jira", external_ref: "PROJ-123" });
    expect(parseIssueFilters(params)).toEqual({ source: "jira", external_ref: "PROJ-123" });
  });
});

describe("applyIssueFilters", () => {
  function mockQuery() {
    const calls: [string, unknown][] = [];
    const q = {
      eq(col: string, val: unknown) {
        calls.push([col, val]);
        return q;
      },
    };
    return { q, calls };
  }

  it("applies status, severity, and priority filters in order", () => {
    const { q, calls } = mockQuery();
    applyIssueFilters(q, { status: "open", severity: "low", priority: "medium" });
    expect(calls).toEqual([
      ["status", "open"],
      ["severity", "low"],
      ["priority", "medium"],
    ]);
  });

  it("applies nothing when filters are empty", () => {
    const { q, calls } = mockQuery();
    applyIssueFilters(q, {});
    expect(calls).toEqual([]);
  });

  it("applies source and external_ref filters (complement seam, R-81)", () => {
    const { q, calls } = mockQuery();
    applyIssueFilters(q, { source: "jira", external_ref: "PROJ-123" });
    expect(calls).toEqual([
      ["source", "jira"],
      ["external_ref", "PROJ-123"],
    ]);
  });
});

describe("ISSUE_SORT_FIELDS", () => {
  it("is a fixed whitelist matching the list API", () => {
    expect(ISSUE_SORT_FIELDS).toEqual([
      "due_date",
      "priority",
      "severity",
      "status",
      "title",
      "created_at",
    ]);
  });
});

/**
 * GET /api/tasks filter parsing + chain application (L-04/L-08).
 * Fills the gap the F1 adversarial verify flagged: the module's own doc
 * comment referenced this file before it existed.
 */
import { describe, it, expect } from "vitest";
import { parseTaskFilters, applyTaskFilters, TASK_SORT_FIELDS } from "./_query";

function params(q: Record<string, string>): URLSearchParams {
  return new URLSearchParams(q);
}

/** Recording mock of the PostgREST chain shape applyTaskFilters uses. */
function mockChain() {
  const calls: [string, ...unknown[]][] = [];
  const chain = {
    calls,
    eq: (col: string, val: unknown) => {
      calls.push(["eq", col, val]);
      return chain;
    },
    ilike: (col: string, val: string) => {
      calls.push(["ilike", col, val]);
      return chain;
    },
    lte: (col: string, val: string) => {
      calls.push(["lte", col, val]);
      return chain;
    },
    gte: (col: string, val: string) => {
      calls.push(["gte", col, val]);
      return chain;
    },
    lt: (col: string, val: string) => {
      calls.push(["lt", col, val]);
      return chain;
    },
    not: (col: string, op: string, val: string) => {
      calls.push(["not", col, op, val]);
      return chain;
    },
  };
  return chain;
}

describe("parseTaskFilters", () => {
  it("maps every supported param", () => {
    const f = parseTaskFilters(
      params({
        project_id: "p1",
        assignee_id: "a1",
        status_type: "started",
        priority: "high",
        due_before: "2026-09-01",
        due_after: "2026-08-01",
        overdue: "true",
        q: "migration",
        source: "jira",
        external_ref: "PROJ-123",
      }),
    );
    expect(f).toEqual({
      project_id: "p1",
      assignee_id: "a1",
      status_type: "started",
      priority: "high",
      due_before: "2026-09-01",
      due_after: "2026-08-01",
      overdue: true,
      q: "migration",
      source: "jira",
      external_ref: "PROJ-123",
    });
  });

  it("ignores unknown params and non-'true' overdue values", () => {
    expect(parseTaskFilters(params({ bogus: "x", overdue: "yes" }))).toEqual({});
    expect(parseTaskFilters(params({}))).toEqual({});
  });
});

describe("applyTaskFilters", () => {
  it("applies only the present filters, in chain form", () => {
    const chain = mockChain();
    applyTaskFilters(chain, { project_id: "p1", q: "audit" }, "2026-08-15");
    expect(chain.calls).toEqual([
      ["eq", "project_id", "p1"],
      ["ilike", "name", "%audit%"],
    ]);
  });

  it("overdue combines a due_date cutoff with the not-completed/canceled exclusion", () => {
    const chain = mockChain();
    applyTaskFilters(chain, { overdue: true }, "2026-08-15");
    expect(chain.calls).toEqual([
      ["lt", "due_date", "2026-08-15"],
      ["not", "status_type", "in", '("completed","canceled")'],
    ]);
  });

  it("no filters → untouched chain", () => {
    const chain = mockChain();
    applyTaskFilters(chain, {}, "2026-08-15");
    expect(chain.calls).toEqual([]);
  });

  it("source and external_ref apply as exact-match eq (complement seam, R-81)", () => {
    const chain = mockChain();
    applyTaskFilters(chain, { source: "jira", external_ref: "PROJ-123" }, "2026-08-15");
    expect(chain.calls).toEqual([
      ["eq", "source", "jira"],
      ["eq", "external_ref", "PROJ-123"],
    ]);
  });
});

describe("TASK_SORT_FIELDS whitelist", () => {
  it("contains only real, safe task columns — never id-ish or isolation columns", () => {
    expect([...TASK_SORT_FIELDS]).toEqual([
      "due_date",
      "priority",
      "status_type",
      "name",
      "created_at",
      "completion_pct",
    ]);
    expect(TASK_SORT_FIELDS).not.toContain("workspace_id");
    expect(TASK_SORT_FIELDS).not.toContain("id");
  });
});

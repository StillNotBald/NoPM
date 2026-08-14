import { describe, it, expect } from "vitest";
import { parseAuditFilters, applyAuditFilters } from "./_query";

describe("parseAuditFilters", () => {
  it("returns an empty object with no params", () => {
    expect(parseAuditFilters(new URLSearchParams())).toEqual({});
  });

  it("extracts target_type, target_id, action, actor_id", () => {
    const params = new URLSearchParams({
      target_type: "task",
      target_id: "t1",
      action: "task.create",
      actor_id: "u1",
    });
    expect(parseAuditFilters(params)).toEqual({
      target_type: "task",
      target_id: "t1",
      action: "task.create",
      actor_id: "u1",
    });
  });

  it("ignores page/limit and unknown params", () => {
    const params = new URLSearchParams({ page: "2", limit: "50", bogus: "x" });
    expect(parseAuditFilters(params)).toEqual({});
  });
});

describe("applyAuditFilters", () => {
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

  it("applies all four filters in order", () => {
    const { q, calls } = mockQuery();
    applyAuditFilters(q, {
      target_type: "task",
      target_id: "t1",
      action: "task.create",
      actor_id: "u1",
    });
    expect(calls).toEqual([
      ["target_type", "task"],
      ["target_id", "t1"],
      ["action", "task.create"],
      ["actor_id", "u1"],
    ]);
  });

  it("applies nothing when filters are empty", () => {
    const { q, calls } = mockQuery();
    applyAuditFilters(q, {});
    expect(calls).toEqual([]);
  });
});

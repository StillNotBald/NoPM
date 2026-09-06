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

  it("extracts a valid channel", () => {
    for (const channel of ["ui", "api", "cli", "mcp", "assistant"]) {
      expect(parseAuditFilters(new URLSearchParams({ channel }))).toEqual({ channel });
    }
  });

  it("ignores an unrecognized channel value", () => {
    expect(parseAuditFilters(new URLSearchParams({ channel: "webhook" }))).toEqual({});
  });

  it("ignores an empty channel value", () => {
    expect(parseAuditFilters(new URLSearchParams({ channel: "" }))).toEqual({});
  });

  it("extracts a valid since timestamp", () => {
    expect(parseAuditFilters(new URLSearchParams({ since: "2026-09-01T00:00:00Z" }))).toEqual({
      since: "2026-09-01T00:00:00Z",
    });
  });

  it("ignores an unparsable since value", () => {
    expect(parseAuditFilters(new URLSearchParams({ since: "not-a-date" }))).toEqual({});
  });

  it("ignores an empty since value", () => {
    expect(parseAuditFilters(new URLSearchParams({ since: "" }))).toEqual({});
  });

  it("extracts a valid order", () => {
    expect(parseAuditFilters(new URLSearchParams({ order: "asc" }))).toEqual({ order: "asc" });
    expect(parseAuditFilters(new URLSearchParams({ order: "desc" }))).toEqual({ order: "desc" });
  });

  it("ignores an unrecognized order value", () => {
    expect(parseAuditFilters(new URLSearchParams({ order: "ascending" }))).toEqual({});
  });

  it("combines since, channel, and order", () => {
    const params = new URLSearchParams({
      since: "2026-09-01T00:00:00Z",
      channel: "cli",
      order: "asc",
    });
    expect(parseAuditFilters(params)).toEqual({
      since: "2026-09-01T00:00:00Z",
      channel: "cli",
      order: "asc",
    });
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

  it("applies the channel filter after the other four", () => {
    const { q, calls } = mockQuery();
    applyAuditFilters(q, {
      target_type: "task",
      channel: "cli",
    });
    expect(calls).toEqual([
      ["target_type", "task"],
      ["channel", "cli"],
    ]);
  });

  it("applies nothing when filters are empty", () => {
    const { q, calls } = mockQuery();
    applyAuditFilters(q, {});
    expect(calls).toEqual([]);
  });
});

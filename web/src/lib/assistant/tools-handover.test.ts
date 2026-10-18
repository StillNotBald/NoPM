/** get_handover_report (M6, R-140): GET only, read scopes only, id-safe. */
import { describe, it, expect } from "vitest";
import { TOOL_REGISTRY, ToolArgError } from "../../../mcp/tools.mjs";
import { TOOLS, TOOL_SCOPES } from "./tools";

const ID = "00000000-0000-4000-a000-000000000001";
const tool = TOOL_REGISTRY.find((t) => t.name === "get_handover_report")!;

describe("get_handover_report", () => {
  it("is registered once and exposed to the assistant", () => {
    expect(TOOL_REGISTRY.filter((t) => t.name === "get_handover_report")).toHaveLength(1);
    expect(TOOLS.some((t) => t.definition.name === "get_handover_report")).toBe(true);
  });

  it("whole workspace by default, one project when asked", () => {
    expect(tool.toRequest({})).toEqual({ path: "/api/reports/handover", method: "GET" });
    expect(tool.toRequest({ project_id: ID })).toEqual({ path: `/api/reports/handover?project_id=${ID}`, method: "GET" });
  });

  it("rejects a hostile project_id before any request exists", () => {
    for (const bad of ["../unlock", `${ID}&format=csv`, `${ID}/x`, "x", 42]) {
      expect(() => tool.toRequest({ project_id: bad })).toThrow(ToolArgError);
    }
  });

  it("takes no required argument and no unknown ones", () => {
    expect(tool.parameters.required).toEqual([]);
    expect(tool.parameters.additionalProperties).toBe(false);
    expect(Object.keys(tool.parameters.properties as object)).toEqual(["project_id"]);
  });

  it("needs only read scopes, all inside the assistant's scope ceiling", () => {
    expect(TOOL_SCOPES).toContain("report:read");
    expect(TOOL_SCOPES.filter((s) => /write|approve|decide|delete/.test(s)).includes("report:read" as never)).toBe(false);
    expect(tool.description).toMatch(/READ-ONLY/);
    expect(tool.toRequest({}).method).toBe("GET");
  });
});

describe("list_pending_approvals mine flag and get_project_trend", () => {
  const pending = TOOL_REGISTRY.find((t) => t.name === "list_pending_approvals")!;
  const trend = TOOL_REGISTRY.find((t) => t.name === "get_project_trend")!;

  it("mine=true adds mine=1; anything else leaves the whole queue", () => {
    expect(pending.toRequest({ mine: true }).path).toBe("/api/review?mine=1");
    expect(pending.toRequest({ mine: false }).path).toBe("/api/review");
    expect(pending.toRequest({ kind: "change_request", mine: true, limit: 5 }).path).toBe("/api/review?kind=change_request&mine=1&limit=5");
    expect(pending.toRequest({}).path).toBe("/api/review");
  });

  it("get_project_trend is a guarded GET with an optional n", () => {
    expect(trend.toRequest({ project_id: ID })).toEqual({ path: `/api/projects/${ID}/trend`, method: "GET" });
    expect(trend.toRequest({ project_id: ID, n: 60 }).path).toBe(`/api/projects/${ID}/trend?n=60`);
    expect(() => trend.toRequest({ project_id: "../unlock" })).toThrow(ToolArgError);
    expect(TOOLS.some((t) => t.definition.name === "get_project_trend")).toBe(true);
  });
});

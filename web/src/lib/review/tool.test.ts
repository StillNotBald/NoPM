/**
 * list_pending_approvals — the MCP / assistant tool over GET /api/review.
 *
 * Locks the three properties that matter for an agent surface:
 *   1. it is READ-ONLY (GET, no body) and is exactly one registry entry shared
 *      by MCP and the in-app assistant;
 *   2. its `kind` enum is the API's PENDING_KINDS, both directions;
 *   3. it never widens the assistant's scope ceiling — no approve/decide scope
 *      is (or becomes) part of TOOL_SCOPES, so an agent can SEE what waits but
 *      cannot decide it.
 * The OpenAPI path/scope cross-check for this tool lives in
 * assistant/tools-openapi.test.ts (it needs /api/review documented there).
 */
import { describe, it, expect } from "vitest";
import { TOOL_REGISTRY, PENDING_APPROVAL_KINDS } from "../../../mcp/tools.mjs";
import { TOOLS, TOOL_SCOPES } from "@/lib/assistant/tools";
import { hasScope } from "@/lib/auth/tokens";
import { PRIVILEGED_SCOPES } from "@/lib/auth/scopes";
import { DECIDE_SCOPES, PENDING_KINDS } from "./pending";

type Params = { properties: Record<string, { enum?: string[] }>; required: string[]; additionalProperties: boolean };

const tool = TOOL_REGISTRY.find((t) => t.name === "list_pending_approvals")!;

describe("list_pending_approvals registry entry", () => {
  it("exists exactly once", () => {
    expect(TOOL_REGISTRY.filter((t) => t.name === "list_pending_approvals")).toHaveLength(1);
  });

  it("is read-only: GET /api/review with no body, even for empty args", () => {
    expect(tool.toRequest({})).toEqual({ path: "/api/review", method: "GET" });
    expect(tool.toRequest({ kind: "timesheet", page: 2, limit: 10 })).toEqual({
      path: "/api/review?kind=timesheet&page=2&limit=10",
      method: "GET",
    });
    expect("body" in tool.toRequest({ kind: "timesheet" })).toBe(false);
  });

  it("takes only optional kind/page/limit and rejects extra properties", () => {
    const p = tool.parameters as Params;
    expect(Object.keys(p.properties).sort()).toEqual(["kind", "limit", "page"]);
    expect(p.required).toEqual([]);
    expect(p.additionalProperties).toBe(false);
  });

  it("kind enum equals the API's PENDING_KINDS exactly (both directions)", () => {
    const e = (tool.parameters as Params).properties.kind.enum!;
    expect([...e].sort()).toEqual([...PENDING_KINDS].sort());
    expect([...PENDING_APPROVAL_KINDS].sort()).toEqual([...PENDING_KINDS].sort());
  });

  it("is the same object in the assistant's TOOLS view (one shared registry)", () => {
    const view = TOOLS.find((t) => t.definition.name === "list_pending_approvals")!;
    expect(view.definition.parameters).toBe(tool.parameters);
  });

  it("tells the model it cannot decide and that an empty list may be scope-limited", () => {
    expect(tool.description).toMatch(/READ-ONLY/);
    expect(tool.description).toMatch(/hidden_kinds/);
  });
});

describe("scope ceiling — an agent can list approvals but never decide them", () => {
  const ceiling: string[] = [...TOOL_SCOPES];

  it("TOOL_SCOPES holds none of the decide scopes", () => {
    for (const s of Object.values(DECIDE_SCOPES)) {
      expect(ceiling, `${s} must never be in the assistant ceiling`).not.toContain(s);
      expect(hasScope(ceiling, s), `${s} must not be granted by the ceiling`).toBe(false);
    }
  });

  it("the decide scopes are exactly the privileged (wildcard-proof) scopes, rebaselines included", () => {
    expect([...Object.values(DECIDE_SCOPES)].sort()).toEqual([...PRIVILEGED_SCOPES].sort());
  });

  it("only list_pending_approvals touches /api/review, and only with GET", () => {
    const touching = TOOL_REGISTRY.filter((t) => t.toRequest({}).path.startsWith("/api/review"));
    expect(touching.map((t) => t.name)).toEqual(["list_pending_approvals"]);
    expect(touching.every((t) => t.toRequest({}).method === "GET")).toBe(true);
  });
});

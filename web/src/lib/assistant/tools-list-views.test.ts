/**
 * Lean list payloads on the agent tools (A7 / K5, R-129): list_projects, list_tasks,
 * list_milestones, list_risks, list_issues take view / fields, forward them safely, and the
 * advertised summary has no charter or lock-detail columns.
 */
import { describe, it, expect } from "vitest";
import { TOOLS } from "./tools";
import { TOOL_REGISTRY } from "../../../mcp/tools.mjs";
import { SUMMARY_COLUMNS } from "@/lib/api/views";

const PID = "11111111-1111-4111-8111-111111111111";
const LIST_TOOLS = ["list_projects", "list_tasks", "list_milestones", "list_risks", "list_issues"] as const;
const tool = (name: string) => TOOLS.find((t) => t.definition.name === name)!;

describe("list tools advertise view and fields", () => {
  for (const name of LIST_TOOLS) {
    it(`${name} has view (summary|full) and fields`, () => {
      const props = (tool(name).definition.parameters as { properties: Record<string, { enum?: string[]; type: string }> }).properties;
      expect(props.view.enum).toEqual(["summary", "full"]);
      expect(props.fields.type).toBe("string");
    });

    it(`${name}: no view/fields leaves the query unchanged (the route default is summary)`, () => {
      const { path, method } = tool(name).toRequest({ project_id: PID });
      expect(method).toBe("GET");
      expect(path).not.toMatch(/view=|fields=/);
    });

    it(`${name}: view and fields are forwarded and URL-encoded`, () => {
      const { path } = tool(name).toRequest({ project_id: PID, view: "full", fields: "id,name" });
      expect(path).toContain("&view=full");
      expect(path).toContain("&fields=id%2Cname");
    });

    it(`${name}: a hostile fields value cannot add a parameter or a path part`, () => {
      const { path } = tool(name).toRequest({ project_id: PID, fields: "id&limit=100000/../unlock#" });
      const query = path.slice(path.indexOf("?") + 1);
      expect([...new URLSearchParams(query).keys()].sort()).toEqual(["fields", "limit", "page"]);
      expect(new URLSearchParams(query).get("limit")).toBe("20");
    });
  }
});

describe("list_projects summary payload", () => {
  it("the summary it asks for by default has no charter or lock-detail keys", () => {
    const summary: readonly string[] = SUMMARY_COLUMNS.projects;
    for (const k of ["business_case", "objective", "scope_summary", "health_commentary", "lock_reason", "locked_by", "locked_at", "source", "external_ref", "external_url"]) {
      expect(summary, k).not.toContain(k);
    }
  });

  it("its description steers agents to the lean default and to get_project for the full record", () => {
    const d = tool("list_projects").definition.description;
    expect(d).toMatch(/summary/i);
    expect(d).toMatch(/get_project/);
  });
});

describe("risk write tools (K1 / K2)", () => {
  for (const name of ["create_risk", "update_risk"]) {
    it(`${name} exposes risk_category and impact_areas, not the legacy category`, () => {
      const props = (tool(name).definition.parameters as { properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }> }).properties;
      expect(props.risk_category.enum).toContain("technical");
      expect(props.impact_areas.items?.enum).toEqual(["schedule", "cost", "scope", "quality", "reputation", "compliance"]);
      expect(props).not.toHaveProperty("category");
    });
  }

  it("the registry is the single shared object", () => {
    expect(TOOL_REGISTRY.length).toBe(TOOLS.length);
  });
});

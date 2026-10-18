import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RISK_IMPACT_AREAS, IMPACT_AREA_OPTIONS } from "./impact-areas";
import { RISK_IMPACT_AREAS as TOOL_AREAS } from "../../../mcp/tools.mjs";
import { createRiskSchema } from "@/app/api/risks/_schema";

describe("risk impact areas have one source of truth", () => {
  it("matches the risk_impact_area enum in migration 0008, in order", () => {
    const sql = readFileSync(join(__dirname, "..", "..", "..", "supabase", "migrations", "20260608000008_content_enrichment.sql"), "utf8");
    const m = sql.match(/create type risk_impact_area\s+as enum \(([^)]*)\)/i);
    expect(m).not.toBeNull();
    const labels = m![1].split(",").map((s) => s.trim().replace(/'/g, ""));
    expect([...RISK_IMPACT_AREAS]).toEqual(labels);
  });
  it("the plain-JS tool registry copy is identical", () => {
    expect([...TOOL_AREAS]).toEqual([...RISK_IMPACT_AREAS]);
  });
  it("the zod schema accepts exactly these values", () => {
    for (const a of RISK_IMPACT_AREAS) {
      expect(createRiskSchema.safeParse({ title: "t", severity: "low", likelihood: "low", impact_areas: [a] }).success).toBe(true);
    }
  });
  it("the select options cover every area", () => {
    expect(IMPACT_AREA_OPTIONS.map((o) => o.value)).toEqual([...RISK_IMPACT_AREAS]);
  });
});

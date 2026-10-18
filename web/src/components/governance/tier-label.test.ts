/** UAT-036: no raw tier value reaches a screen; every tier badge goes through one helper. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TIER_LABELS, tierLabel } from "./tier-label";

const src = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

describe("tierLabel", () => {
  it("names every tier in words", () => {
    expect(tierLabel("routine")).toBe("Routine");
    expect(tierLabel("normal")).toBe("Normal");
    expect(tierLabel("high_risk")).toBe("High risk");
    expect(tierLabel("emergency")).toBe("Emergency");
    expect(tierLabel("strategic")).toBe("Strategic");
    expect(Object.keys(TIER_LABELS)).toHaveLength(5);
  });
  it("never returns an underscore value for an unknown tier", () => {
    expect(tierLabel("very_high_risk")).toBe("Very high risk");
    expect(tierLabel("very_high_risk")).not.toContain("_");
  });
});

describe("every tier badge uses the helper", () => {
  it.each([
    "components/review/queue-list.tsx",
    "components/change-control/change-detail.tsx",
    "app/(console)/approvals/page.tsx",
  ])("%s", (f) => {
    const s = src(f);
    expect(s).toContain("tierLabel(");
    expect(s).not.toMatch(/TIER_TEXT|TIER_LABEL\b/);
  });
  it("the Approvals badge keeps the red Emergency tone", () => {
    expect(src("app/(console)/approvals/page.tsx")).toMatch(/req\.tier === "emergency" \? "danger"/);
  });
  it("no source prints a raw req.tier or item.tier", () => {
    expect(src("app/(console)/approvals/page.tsx")).not.toMatch(/>\{req\.tier\}</);
    expect(src("components/review/queue-list.tsx")).not.toMatch(/>\s*\{item\.tier\}\s*</);
  });
});

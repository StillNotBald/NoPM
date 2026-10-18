import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HealthRollupCards } from "./health-rollup-cards";

const base = {
  totalProjects: 4,
  greenCount: 2,
  amberCount: 1,
  redCount: 1,
  completeCount: 0,
  riskCount: 3,
  issueCount: 5,
  clashCount: 2,
  overdueCount: 1,
};
const html = (extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(HealthRollupCards, { ...base, ...extra }));

describe("HealthRollupCards degraded registers", () => {
  it("shows the counts when every register loaded", () => {
    const m = html();
    expect(m).toContain("5 open issues · 2 clashes");
    expect(m).not.toContain("unavailable");
  });

  it("shows a failed clashes read as unavailable, not as 0, and keeps the rest", () => {
    const m = html({ clashCount: 0, unavailable: { clashes: true } });
    expect(m).toContain("5 open issues · clashes unavailable");
    expect(m).not.toContain("0 clashes");
    expect(m).toContain("Portfolio health");
  });

  it("shows a failed risks read as an em dash with a reason", () => {
    const m = html({ riskCount: 0, unavailable: { risks: true } });
    expect(m).toContain("—");
    expect(m).toContain("risks unavailable");
  });
});

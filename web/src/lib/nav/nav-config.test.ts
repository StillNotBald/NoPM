/**
 * Nav config (R-78) — pure section filtering for progressive disclosure.
 */
import { describe, it, expect } from "vitest";
import { NAV_SECTIONS, ESSENTIAL_HREFS, visibleSections, hiddenCount, type NavSection } from "./nav-config";

const ALL_HREFS = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href));
const TOTAL_ITEMS = ALL_HREFS.length;

describe("ESSENTIAL_HREFS", () => {
  it("has exactly 7 items", () => {
    expect(ESSENTIAL_HREFS).toHaveLength(7);
  });

  it("every essential href exists somewhere in NAV_SECTIONS (guards against a silent typo)", () => {
    for (const href of ESSENTIAL_HREFS) {
      expect(ALL_HREFS).toContain(href);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(ESSENTIAL_HREFS).size).toBe(ESSENTIAL_HREFS.length);
  });
});

describe("visibleSections — all mode", () => {
  it("returns sections unchanged (identity)", () => {
    expect(visibleSections(NAV_SECTIONS, "all", "/dashboard")).toEqual(NAV_SECTIONS);
  });

  it("is unaffected by pathname", () => {
    expect(visibleSections(NAV_SECTIONS, "all", null)).toEqual(NAV_SECTIONS);
  });
});

describe("visibleSections — essentials mode", () => {
  it("keeps exactly the 7 essential items when the active route is itself essential", () => {
    const result = visibleSections(NAV_SECTIONS, "essentials", "/dashboard");
    const hrefs = result.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs.sort()).toEqual([...ESSENTIAL_HREFS].sort());
  });

  it("keeps a non-essential active route visible in its own section, in addition to the 7", () => {
    const result = visibleSections(NAV_SECTIONS, "essentials", "/mainline");
    const hrefs = result.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain("/mainline");
    for (const href of ESSENTIAL_HREFS) expect(hrefs).toContain(href);
    expect(hrefs).toHaveLength(ESSENTIAL_HREFS.length + 1);
  });

  it("matches a nested active route (pathname starts with href + '/')", () => {
    const result = visibleSections(NAV_SECTIONS, "essentials", "/mainline/some-sub-page");
    const hrefs = result.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).toContain("/mainline");
  });

  it("does not false-positive match a non-essential item on a prefix without a boundary", () => {
    // "/mainline" is non-essential; "/mainlineish" shares the prefix but is
    // not the same route and has no boundary "/" after it — must NOT match.
    const result = visibleSections(NAV_SECTIONS, "essentials", "/mainlineish");
    const hrefs = result.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs).not.toContain("/mainline");
    expect(hrefs.sort()).toEqual([...ESSENTIAL_HREFS].sort());
  });

  it("drops sections left empty after filtering", () => {
    const result = visibleSections(NAV_SECTIONS, "essentials", "/dashboard");
    const capacitySection = result.find((s) => s.label === "Capacity");
    expect(capacitySection).toBeUndefined();
  });

  it("null pathname keeps just the 7 essentials, no crash", () => {
    const result = visibleSections(NAV_SECTIONS, "essentials", null);
    const hrefs = result.flatMap((s) => s.items.map((i) => i.href));
    expect(hrefs.sort()).toEqual([...ESSENTIAL_HREFS].sort());
  });

  it("does not mutate the input sections", () => {
    const before = JSON.stringify(NAV_SECTIONS);
    visibleSections(NAV_SECTIONS, "essentials", "/mainline");
    expect(JSON.stringify(NAV_SECTIONS)).toBe(before);
  });
});

describe("hiddenCount", () => {
  it("is 0 in all mode", () => {
    expect(hiddenCount(NAV_SECTIONS, "all", "/dashboard")).toBe(0);
  });

  it("equals total minus essentials when the active route is essential", () => {
    expect(hiddenCount(NAV_SECTIONS, "essentials", "/dashboard")).toBe(
      TOTAL_ITEMS - ESSENTIAL_HREFS.length,
    );
  });

  it("accounts for one extra visible item when the active route is non-essential", () => {
    expect(hiddenCount(NAV_SECTIONS, "essentials", "/mainline")).toBe(
      TOTAL_ITEMS - ESSENTIAL_HREFS.length - 1,
    );
  });
});

describe("NAV_SECTIONS shape sanity", () => {
  it("has no duplicate hrefs across the whole config", () => {
    expect(new Set(ALL_HREFS).size).toBe(ALL_HREFS.length);
  });

  it("every section has at least one item", () => {
    const empty = NAV_SECTIONS.filter((s: NavSection) => s.items.length === 0);
    expect(empty).toEqual([]);
  });
});

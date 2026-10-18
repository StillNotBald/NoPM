/**
 * Guard tests for wave3-mobile / W3-T3-landing-heatmap.
 *
 * Source-inspection pattern (see src/components/layout/mobile-chrome.test.ts)
 * rather than mounting React — no jsdom/@testing-library in this project
 * (vitest.config.ts runs `environment: "node"` and only globs
 * `src/**\/*.test.ts`, not .tsx). Also exercises the exported scoring helpers
 * directly (those already run fine under a plain node test).
 *
 * Width-math finding (recon, not asserted by layout tests below — jsdom
 * isn't available to actually measure it): the grid itself uses
 * `grid-cols-[auto_repeat(5,minmax(0,1fr))]`, the standard "prevent grid
 * blowout" pattern — those 5 data-column tracks can shrink to 0 and will
 * NOT force the page wide. The one non-shrinking part of the original
 * markup was the legend, a plain flex sibling (not `min-w-0`) with
 * `whitespace-nowrap` labels — a real but small (~70-90px) floor, unlikely
 * on its own to blow out a 390px viewport. So "drags the whole page wide"
 * was PLAUSIBLE-not-CONFIRMED as literally stated; the more likely mobile
 * defect was cells squishing into thin non-square rectangles (aspect-square
 * height derived from a shrunk fr-track width, clamped tall by
 * min-h-[56px]). The overflow-x-auto + min-w-[420px] wrapper added below
 * fixes both: guarantees comfortable near-square cells and gives the
 * grid+legend row a floor that scrolls instead of squishing, while staying
 * a no-op on desktop (420 < the existing max-w-[460px] cap).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  probabilityBand,
  riskScore,
  exposureBand,
} from "./risk-heatmap";

const SOURCE = readFileSync(
  join(process.cwd(), "src", "components", "registers", "risk-heatmap.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// 1. Overflow wrapper — mirrors the register table's proven pattern
// ---------------------------------------------------------------------------
describe("risk-heatmap.tsx — scrolls on narrow viewports instead of squishing/overflowing", () => {
  it("wraps the grid+legend row in overflow-x-auto (same pattern as risks/page.tsx's table wrapper)", () => {
    expect(SOURCE).toMatch(/<div className="overflow-x-auto">/);
  });

  it("gives the scrollable row an explicit min-width so cells stay usable instead of squishing to 0", () => {
    expect(SOURCE).toMatch(/min-w-\[420px\]/);
  });

  it("centers via mx-auto (not a `flex justify-center` parent) so an overflowing/scrolled row starts at scroll position 0, not the flexbox centered-overflow clipping quirk", () => {
    expect(SOURCE).toMatch(/mx-auto flex items-stretch/);
    // Only the JSX (not this file's own explanatory comments) matters here —
    // scan className attribute values specifically.
    const classNameValues = SOURCE.match(/className="[^"]*"/g) ?? [];
    expect(classNameValues.some((c) => c === 'className="flex justify-center"')).toBe(false);
  });

  it("keeps the desktop cap unchanged at max-w-[460px] (wider than the new 420px floor — desktop pixel-identical)", () => {
    expect(SOURCE).toMatch(/max-w-\[460px\]/);
  });
});

// ---------------------------------------------------------------------------
// 2. Existing scoring/banding contract — unchanged by the layout fix
// ---------------------------------------------------------------------------
describe("risk-heatmap.tsx — scoring helpers (regression guard, unrelated to the layout fix)", () => {
  it("probabilityBand buckets 0-100 into 1-5 bands", () => {
    expect(probabilityBand(null)).toBe(0);
    expect(probabilityBand(1)).toBe(1);
    expect(probabilityBand(20)).toBe(1);
    expect(probabilityBand(21)).toBe(2);
    expect(probabilityBand(100)).toBe(5);
  });

  it("riskScore rounds probability/20 * impact, clamped 1-5", () => {
    expect(riskScore(null, 3)).toBeNull();
    expect(riskScore(80, null)).toBeNull();
    expect(riskScore(100, 5)).toBe(5);
    expect(riskScore(20, 1)).toBe(1);
  });

  it("exposureBand maps score to a band label", () => {
    expect(exposureBand(null)).toBeNull();
    expect(exposureBand(1)).toBe("low");
    expect(exposureBand(2)).toBe("medium");
    expect(exposureBand(4)).toBe("high");
    expect(exposureBand(5)).toBe("critical");
  });
});

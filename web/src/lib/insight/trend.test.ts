import { describe, it, expect } from "vitest";
import { computeTrend, normalizeSeries, suggestionLine, TREND_THRESHOLDS, type SnapshotPoint } from "./trend";

function day(n: number): string {
  return new Date(Date.UTC(2026, 8, 1 + n)).toISOString().slice(0, 10);
}
function pt(n: number, over: Partial<SnapshotPoint> = {}): SnapshotPoint {
  return { taken_at: day(n), spi: 1, cpi: 1, slip_days: 0, completion_pct: 40, ...over };
}
const series = (count: number, f: (i: number) => Partial<SnapshotPoint>) =>
  Array.from({ length: count }, (_, i) => pt(i, f(i)));

describe("computeTrend", () => {
  it("has no suggestion without snapshots", () => {
    const t = computeTrend([]);
    expect(t.suggested_rag).toBeNull();
    expect(t.snapshots).toBe(0);
    expect(suggestionLine(t)).toBeNull();
  });

  it("is green on plan", () => {
    const t = computeTrend(series(8, () => ({ spi: 1.02, cpi: 1.01 })));
    expect(t.suggested_rag).toBe("green");
    expect(t.confidence).toBe("ok");
    expect(t.reason).toBe("On plan");
  });

  it("marks a single snapshot low confidence but still reads its level", () => {
    const t = computeTrend([pt(0, { slip_days: 12 })]);
    expect(t.suggested_rag).toBe("red");
    expect(t.confidence).toBe("low");
  });

  it("red when slip is more than 10 days, not at exactly 10", () => {
    expect(computeTrend(series(5, () => ({ slip_days: TREND_THRESHOLDS.redSlipDays + 1 }))).suggested_rag).toBe("red");
    expect(computeTrend(series(5, () => ({ slip_days: TREND_THRESHOLDS.redSlipDays }))).suggested_rag).not.toBe("red");
  });

  it("red when CPI stays under 0.9 for 3 snapshots, amber for only 2", () => {
    const three = computeTrend(series(6, (i) => ({ cpi: i >= 3 ? 0.85 : 1 })));
    expect(three.suggested_rag).toBe("red");
    const two = computeTrend(series(6, (i) => ({ cpi: i >= 4 ? 0.85 : 1 })));
    expect(two.suggested_rag).toBe("amber");
  });

  it("red when SPI stays under 0.9 for 3 snapshots", () => {
    expect(computeTrend(series(5, (i) => ({ spi: i >= 2 ? 0.8 : 1 }))).suggested_rag).toBe("red");
  });

  it("amber on slip over 3 days, or an index under 0.95", () => {
    expect(computeTrend(series(5, () => ({ slip_days: 4 }))).suggested_rag).toBe("amber");
    expect(computeTrend(series(5, () => ({ spi: 0.93 }))).suggested_rag).toBe("amber");
    expect(computeTrend(series(5, () => ({ cpi: 0.94 }))).suggested_rag).toBe("amber");
    expect(computeTrend(series(5, () => ({ slip_days: 3 }))).suggested_rag).toBe("green");
  });

  it("amber when slip grows by more than a day a week even while small", () => {
    const t = computeTrend(series(15, (i) => ({ slip_days: Math.floor(i / 3) })));
    expect(t.slip_per_week).toBeGreaterThan(TREND_THRESHOLDS.slipGrowthPerWeek);
    expect(t.suggested_rag).toBe("amber");
    expect(t.reason).toContain("growing");
  });

  it("amber when SPI is falling but still near 1, and says how long it has been falling", () => {
    const t = computeTrend(series(22, (i) => ({ spi: 1 - i * 0.004 }))); // 1.00 down to 0.916 over three weeks
    expect(t.spi.direction).toBe("falling");
    expect(t.spi.falling_days).toBe(21);
    expect(t.suggested_rag).toBe("amber");
    expect(suggestionLine(t)).toBe("Suggested RAG: amber (SPI 0.92 falling over 3 weeks)");
  });

  it("does not flag a rising index as falling", () => {
    const t = computeTrend(series(10, (i) => ({ spi: 0.9 + i * 0.01 })));
    expect(t.spi.direction).toBe("rising");
    expect(t.spi.falling_days).toBe(0);
  });

  it("suggests nothing once the project is 100% complete", () => {
    expect(computeTrend(series(5, () => ({ completion_pct: 100, slip_days: 30 }))).suggested_rag).toBeNull();
  });

  it("measures slip in days per week across the window", () => {
    const t = computeTrend(series(15, (i) => ({ slip_days: i }))); // 14 days over 14 days = 7 a week
    expect(t.slip_per_week).toBe(7);
  });

  it("only looks at the last N snapshots, one point per day, in date order", () => {
    const pts = [
      pt(3, { slip_days: 20 }),
      pt(0, { slip_days: 0 }),
      pt(1, { slip_days: 0 }),
      pt(2, { slip_days: 0 }),
      pt(3, { slip_days: 0 }),
    ];
    expect(normalizeSeries(pts).map((p) => p.taken_at)).toEqual([day(0), day(1), day(2), day(3)]);
    expect(normalizeSeries(pts)[3].slip_days).toBe(0); // the later duplicate wins
    expect(normalizeSeries(series(40, () => ({})), 10)).toHaveLength(10);
    // an old red patch outside the window does not colour today
    const old = [...series(10, () => ({ slip_days: 30 })), ...Array.from({ length: 10 }, (_, i) => pt(10 + i))];
    expect(computeTrend(old, 8).suggested_rag).toBe("green");
  });
});

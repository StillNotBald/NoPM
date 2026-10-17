import { describe, expect, it } from "vitest";
import { computeDonutArcs, DONUT_GAP } from "./donut-arcs";

const C = 2 * Math.PI * 51; // size 120, thickness 18 -> r 51

const seg = (label: string, value: number) => ({ label, value });

describe("computeDonutArcs", () => {
  it("returns no arcs for an empty or all-zero donut", () => {
    expect(computeDonutArcs([], C)).toEqual([]);
    expect(computeDonutArcs([seg("a", 0), seg("b", 0)], C)).toEqual([]);
  });

  it("paints the FIRST slice from 12 o'clock (offset 0), not off the end of the ring", () => {
    const arcs = computeDonutArcs([seg("on track", 2), seg("at risk", 1)], C);
    expect(arcs[0].seg.label).toBe("on track");
    expect(arcs[0].startLength).toBe(0);
    expect(arcs[0].dashoffset).toBe(0);
    expect(arcs[0].dash).toBeCloseTo((2 / 3) * C - DONUT_GAP, 6);
  });

  it("starts each later slice exactly where the previous one ended", () => {
    // The audit's seed mix: 3 on track, 2 at risk, 1 delayed (+ a complete one).
    const values = [2, 2, 1, 1];
    const arcs = computeDonutArcs(values.map((v, i) => seg(`s${i}`, v)), C);
    const total = values.reduce((a, b) => a + b, 0);
    let cumulative = 0;
    arcs.forEach((arc, i) => {
      expect(arc.startLength).toBeCloseTo((cumulative / total) * C, 6);
      // negative offset moves the dash forward along the path
      expect(arc.dashoffset === 0 ? 0 : -arc.dashoffset).toBeCloseTo(arc.startLength, 6);
      cumulative += values[i];
    });
    // the last slice ends at the end of the ring (before its trailing gap)
    const last = arcs[arcs.length - 1];
    expect(last.startLength + last.dash + DONUT_GAP).toBeCloseTo(C, 6);
  });

  it("uses a dash pattern of [dash, rest] so the slice is painted once, not repeated", () => {
    const [arc] = computeDonutArcs([seg("a", 1), seg("b", 3)], C);
    const [dash, rest] = arc.dasharray.split(" ").map(Number);
    expect(dash).toBeCloseTo(arc.dash, 6);
    expect(dash + rest).toBeCloseTo(C, 6);
  });

  it("draws a single-status portfolio as one complete ring with no gap", () => {
    const arcs = computeDonutArcs([seg("at risk", 1), seg("on track", 0)], C);
    expect(arcs).toHaveLength(1);
    expect(arcs[0].startLength).toBe(0);
    expect(arcs[0].dashoffset).toBe(0);
    expect(arcs[0].dash).toBeCloseTo(C, 6);
    const [dash, rest] = arcs[0].dasharray.split(" ").map(Number);
    expect(dash).toBeCloseTo(C, 6);
    expect(rest).toBeCloseTo(0, 6);
  });

  it("skips zero, negative and non-finite slices without disturbing the others", () => {
    const arcs = computeDonutArcs(
      [seg("a", 1), seg("zero", 0), seg("neg", -4), seg("nan", Number.NaN), seg("b", 1)],
      C,
    );
    expect(arcs.map((a) => a.seg.label)).toEqual(["a", "b"]);
    expect(arcs[1].startLength).toBeCloseTo(C / 2, 6);
  });

  it("never emits a negative dash even when the gap exceeds a tiny slice", () => {
    const arcs = computeDonutArcs([seg("big", 10_000), seg("tiny", 1)], C);
    for (const a of arcs) expect(a.dash).toBeGreaterThanOrEqual(0);
  });

  it("slice lengths plus gaps cover the whole ring", () => {
    const arcs = computeDonutArcs([seg("a", 5), seg("b", 3), seg("c", 2)], C);
    const painted = arcs.reduce((sum, a) => sum + a.dash, 0);
    expect(painted + arcs.length * DONUT_GAP).toBeCloseTo(C, 6);
  });
});

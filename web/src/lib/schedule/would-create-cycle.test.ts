import { describe, it, expect } from "vitest";
import { wouldCreateCycle, type DependencyEdge } from "./would-create-cycle";

const e = (predecessor_id: string, successor_id: string): DependencyEdge => ({
  predecessor_id,
  successor_id,
});

describe("wouldCreateCycle", () => {
  it("accepts an edge into an empty graph", () => {
    expect(wouldCreateCycle([], "a", "b")).toBe(false);
  });

  it("rejects a self-edge", () => {
    expect(wouldCreateCycle([], "a", "a")).toBe(true);
  });

  it("rejects the direct reverse of an existing edge", () => {
    expect(wouldCreateCycle([e("a", "b")], "b", "a")).toBe(true);
  });

  it("rejects an edge closing a long chain", () => {
    const chain = [e("a", "b"), e("b", "c"), e("c", "d")];
    expect(wouldCreateCycle(chain, "d", "a")).toBe(true);
  });

  it("accepts a forward shortcut along an existing chain", () => {
    const chain = [e("a", "b"), e("b", "c"), e("c", "d")];
    expect(wouldCreateCycle(chain, "a", "d")).toBe(false);
  });

  it("accepts diamond joins (two routes to the same node)", () => {
    const diamond = [e("a", "b"), e("a", "c"), e("b", "d")];
    expect(wouldCreateCycle(diamond, "c", "d")).toBe(false);
  });

  it("accepts unrelated components", () => {
    expect(wouldCreateCycle([e("a", "b"), e("x", "y")], "y", "a")).toBe(false);
  });

  it("terminates on a pre-existing cycle that does not involve the new edge", () => {
    const loop = [e("p", "q"), e("q", "p")];
    expect(wouldCreateCycle(loop, "a", "p")).toBe(false);
  });

  it("handles a very deep chain without recursion limits", () => {
    const n = 50_000;
    const chain: DependencyEdge[] = [];
    for (let i = 0; i < n; i++) chain.push(e(`t${i}`, `t${i + 1}`));
    expect(wouldCreateCycle(chain, `t${n}`, "t0")).toBe(true);
    expect(wouldCreateCycle(chain, "t0", `t${n}`)).toBe(false);
  });
});

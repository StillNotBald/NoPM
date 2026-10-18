import { describe, it, expect } from "vitest";
import type { RagStatus } from "@/lib/status";
import { computeContingentOn } from "./program-rollup";
import {
  computeContingency,
  MAX_CONTINGENCY_DEPTH,
  wouldCreateProjectCycle,
} from "./project-contingency";

const rags = (o: Record<string, RagStatus>) => new Map(Object.entries(o));
const edge = (project_id: string, depends_on_project_id: string) => ({ project_id, depends_on_project_id });

describe("computeContingency", () => {
  it("has no dependencies: not contingent, nothing worst", () => {
    expect(computeContingency("a", rags({ a: "green" }), [])).toEqual({
      declared_rag: "green",
      worst_dependency_rag: null,
      contingent_on_red: false,
      chain: [],
      depth_capped: false,
    });
  });

  it("a direct red dependency makes the project contingent, declared RAG untouched", () => {
    const r = computeContingency("a", rags({ a: "green", b: "red" }), [edge("a", "b")]);
    expect(r).toMatchObject({ declared_rag: "green", worst_dependency_rag: "red", contingent_on_red: true, chain: ["a", "b"] });
  });

  it("finds a red project transitively and returns the whole chain", () => {
    const r = computeContingency("a", rags({ a: "green", b: "green", c: "amber", d: "red" }), [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "d"),
    ]);
    expect(r.contingent_on_red).toBe(true);
    expect(r.chain).toEqual(["a", "b", "c", "d"]);
  });

  it("reports the worst RAG when nothing is red (amber beats not_started beats green)", () => {
    const r = computeContingency("a", rags({ a: "green", b: "not_started", c: "amber", d: "green" }), [
      edge("a", "b"),
      edge("a", "c"),
      edge("a", "d"),
    ]);
    expect(r).toMatchObject({ worst_dependency_rag: "amber", contingent_on_red: false, chain: [] });
  });

  it("a complete dependency is not a risk", () => {
    const r = computeContingency("a", rags({ a: "green", b: "complete" }), [edge("a", "b")]);
    expect(r).toMatchObject({ worst_dependency_rag: "complete", contingent_on_red: false });
  });

  it("only follows edges in the dependency direction", () => {
    const r = computeContingency("a", rags({ a: "green", b: "red" }), [edge("b", "a")]);
    expect(r.contingent_on_red).toBe(false);
  });

  it("is cycle-safe: a loop in bad data terminates and the project is not its own culprit", () => {
    const r = computeContingency("a", rags({ a: "red", b: "amber", c: "green" }), [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "a"),
    ]);
    expect(r.worst_dependency_rag).toBe("amber");
    expect(r.contingent_on_red).toBe(false);
  });

  it("takes the shortest chain when two routes reach the red project", () => {
    const r = computeContingency("a", rags({ a: "green", b: "green", c: "green", d: "red" }), [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "d"),
      edge("a", "d"),
    ]);
    expect(r.chain).toEqual(["a", "d"]);
  });

  it("caps the walk at depth 5: a red project at depth 5 counts, at depth 6 does not", () => {
    const ids = ["p0", "p1", "p2", "p3", "p4", "p5", "p6"];
    const chain = ids.slice(0, -1).map((id, i) => edge(id, ids[i + 1]));
    const at5 = computeContingency("p0", rags({ ...Object.fromEntries(ids.map((i) => [i, "green"])), p5: "red" }), chain);
    expect(MAX_CONTINGENCY_DEPTH).toBe(5);
    expect(at5.contingent_on_red).toBe(true);
    expect(at5.chain).toEqual(["p0", "p1", "p2", "p3", "p4", "p5"]);

    const at6 = computeContingency("p0", rags({ ...Object.fromEntries(ids.map((i) => [i, "green"])), p6: "red" }), chain);
    expect(at6.contingent_on_red).toBe(false);
    expect(at6.depth_capped).toBe(true);
  });

  it("accepts a plain record as well as a map, and ignores self edges and unknown projects", () => {
    const r = computeContingency("a", { a: "green", b: "red" }, [edge("a", "a"), edge("a", "ghost"), edge("a", "b")]);
    expect(r.contingent_on_red).toBe(true);
  });
});

describe("wouldCreateProjectCycle", () => {
  it("detects a direct reverse edge, a longer loop and a self edge", () => {
    const edges = [edge("a", "b"), edge("b", "c")];
    expect(wouldCreateProjectCycle(edges, "b", "a")).toBe(true);
    expect(wouldCreateProjectCycle(edges, "c", "a")).toBe(true);
    expect(wouldCreateProjectCycle(edges, "a", "a")).toBe(true);
  });

  it("allows a forward edge, a diamond and an unrelated edge", () => {
    const edges = [edge("a", "b"), edge("b", "c")];
    expect(wouldCreateProjectCycle(edges, "a", "c")).toBe(false);
    expect(wouldCreateProjectCycle(edges, "d", "a")).toBe(false);
    expect(wouldCreateProjectCycle(edges, "x", "y")).toBe(false);
  });
});

describe("computeContingentOn (program rollup)", () => {
  const projects = (o: Record<string, RagStatus>) => Object.entries(o).map(([id, ragStatus]) => ({ id, ragStatus }));

  it("marks a green project that depends on a red one, naming the red project", () => {
    const m = computeContingentOn(projects({ a: "green", b: "red" }), [edge("a", "b")]);
    expect(m.get("a")).toEqual({ projectId: "b", chain: ["a", "b"] });
    expect(m.get("b")).toBeNull();
  });

  it("marks amber and not_started projects too, but never red or complete ones", () => {
    const m = computeContingentOn(projects({ a: "amber", b: "not_started", c: "red", d: "complete", x: "red" }), [
      edge("a", "x"),
      edge("b", "x"),
      edge("c", "x"),
      edge("d", "x"),
    ]);
    expect(m.get("a")?.projectId).toBe("x");
    expect(m.get("b")?.projectId).toBe("x");
    expect(m.get("c")).toBeNull();
    expect(m.get("d")).toBeNull();
  });

  it("marks through a chain, leaves independent projects unmarked and returns an entry for every project", () => {
    const m = computeContingentOn(projects({ a: "green", b: "green", c: "red", z: "green" }), [edge("a", "b"), edge("b", "c")]);
    expect(m.get("a")?.chain).toEqual(["a", "b", "c"]);
    expect(m.get("b")?.chain).toEqual(["b", "c"]);
    expect(m.get("z")).toBeNull();
    expect([...m.keys()].sort()).toEqual(["a", "b", "c", "z"]);
  });
});

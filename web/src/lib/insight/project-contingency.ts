/**
 * Project contingency (R-147, audit item B5) - pure graph math, no I/O.
 *
 * A project that DEPENDS ON other projects (project_dependencies, edge
 * project -> depends_on) inherits their risk. This module walks those edges
 * (transitively, depth-capped, cycle-safe) and reports the worst declared RAG
 * among the projects it depends on, plus the shortest chain of projects that
 * leads to the worst one.
 *
 * The result is a SUGGESTION. The declared RAG of a project is never read back
 * into a decision and never written: a green project with a red dependency stays
 * green, it is only marked "contingent".
 */

import type { RagStatus } from "@/lib/status";

export const MAX_CONTINGENCY_DEPTH = 5;

export interface DependencyEdgeLike {
  project_id: string;
  depends_on_project_id: string;
}

export interface ContingencyResult {
  /** The project's own declared RAG (untouched). */
  declared_rag: RagStatus | null;
  /** Worst declared RAG among everything it depends on (red > amber > not_started > green > complete), or null with no dependencies. */
  worst_dependency_rag: RagStatus | null;
  /** True when at least one project it depends on (within the depth cap) is declared red. */
  contingent_on_red: boolean;
  /** Project ids from this project down to the project that causes the flag: [self, ..., culprit]. Empty when not contingent. */
  chain: string[];
  /** True when the walk stopped at the depth cap with more edges still unexplored. */
  depth_capped: boolean;
}

const WORST_FIRST: readonly RagStatus[] = ["red", "amber", "not_started", "green", "complete"];
const rank = (r: RagStatus | null | undefined) => {
  const i = r ? WORST_FIRST.indexOf(r) : -1;
  return i < 0 ? WORST_FIRST.length : i;
};

/** Breadth-first walk so the first path found to a project is the shortest. */
export function computeContingency(
  projectId: string,
  ragById: ReadonlyMap<string, RagStatus> | Readonly<Record<string, RagStatus>>,
  edges: readonly DependencyEdgeLike[],
  maxDepth: number = MAX_CONTINGENCY_DEPTH,
): ContingencyResult {
  const ragOf = (id: string): RagStatus | null =>
    (ragById instanceof Map ? ragById.get(id) : (ragById as Record<string, RagStatus>)[id]) ?? null;

  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (e.project_id === e.depends_on_project_id) continue;
    const list = out.get(e.project_id) ?? [];
    list.push(e.depends_on_project_id);
    out.set(e.project_id, list);
  }

  const parent = new Map<string, string>();
  const visited = new Set<string>([projectId]);
  let frontier = [projectId];
  let depthCapped = false;
  let worst: { id: string; rag: RagStatus } | null = null;

  for (let depth = 1; frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const dep of out.get(id) ?? []) {
        if (visited.has(dep)) continue; // cycle-safe: each project is entered once
        if (depth > maxDepth) {
          depthCapped = true;
          continue;
        }
        visited.add(dep);
        parent.set(dep, id);
        next.push(dep);
        const rag = ragOf(dep);
        if (rag && (!worst || rank(rag) < rank(worst.rag))) worst = { id: dep, rag };
      }
    }
    frontier = next;
  }

  const contingentOnRed = worst?.rag === "red";
  const chain: string[] = [];
  if (contingentOnRed && worst) {
    for (let at: string | undefined = worst.id; at !== undefined; at = parent.get(at)) chain.unshift(at);
    if (chain[0] !== projectId) chain.unshift(projectId);
  }

  return {
    declared_rag: ragOf(projectId),
    worst_dependency_rag: worst?.rag ?? null,
    contingent_on_red: contingentOnRed,
    chain,
    depth_capped: depthCapped,
  };
}

/**
 * True when adding `projectId depends on dependsOnId` would close a loop: the new
 * target can already reach the project through existing edges (any kind).
 * The database trigger refuses the same case; this gives a clean 422 first.
 */
export function wouldCreateProjectCycle(
  edges: readonly DependencyEdgeLike[],
  projectId: string,
  dependsOnId: string,
): boolean {
  if (projectId === dependsOnId) return true;
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const list = out.get(e.project_id) ?? [];
    list.push(e.depends_on_project_id);
    out.set(e.project_id, list);
  }
  const seen = new Set<string>([dependsOnId]);
  const stack = [dependsOnId];
  while (stack.length > 0) {
    const at = stack.pop()!;
    if (at === projectId) return true;
    for (const next of out.get(at) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

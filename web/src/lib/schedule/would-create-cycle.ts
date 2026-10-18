/**
 * Cycle guard for the task dependency graph — pure, no I/O.
 *
 * Adding an edge predecessor -> successor closes a loop exactly when the
 * successor can already reach the predecessor by following existing edges.
 * That reachability question is answered with an iterative breadth-first
 * search (no recursion, so deep chains cannot overflow the stack).
 */

export interface DependencyEdge {
  predecessor_id: string;
  successor_id: string;
}

/**
 * True when inserting `predecessorId -> successorId` into `edges` would
 * create a circular dependency (including the degenerate self-edge).
 *
 * `edges` should already be scoped to one workspace/project by the caller.
 */
export function wouldCreateCycle(
  edges: readonly DependencyEdge[],
  predecessorId: string,
  successorId: string,
): boolean {
  if (predecessorId === successorId) return true;

  const next = new Map<string, string[]>();
  for (const e of edges) {
    const list = next.get(e.predecessor_id);
    if (list) list.push(e.successor_id);
    else next.set(e.predecessor_id, [e.successor_id]);
  }

  // BFS from the would-be successor, looking for the would-be predecessor.
  const seen = new Set<string>([successorId]);
  const frontier: string[] = [successorId];
  for (let head = 0; head < frontier.length; head++) {
    for (const id of next.get(frontier[head]) ?? []) {
      if (id === predecessorId) return true;
      if (!seen.has(id)) {
        seen.add(id);
        frontier.push(id);
      }
    }
  }
  return false;
}

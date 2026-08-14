/**
 * Mainline — pure layout math for the 3-lens timeline UI (L-12, R-28).
 *
 * Extracted so the geometry (date→pixel, lane assignment, DAG leveling,
 * label-density capping) is unit-testable without mounting React or a
 * browser. No I/O, no React — safe to import client or server.
 *
 * The feed is O(workspace) (a few hundred nodes on the seeded demo
 * workspace) — `capLabels` is the perf guard: every node still gets a mark,
 * but only a spaced-out subset gets a text label, so the SVG never has to
 * lay out hundreds of <text> nodes at once.
 */

// ── Date → pixel ──────────────────────────────────────────────────────────────

/**
 * Proportional X position of `iso` between `axisStartIso` and `axisEndIso`,
 * clamped to [0, width]. Returns 0 for a degenerate/invalid axis (end <=
 * start, or an unparseable date) rather than NaN/Infinity — callers can
 * render that as "at the left edge" without special-casing it.
 */
export function dateToX(
  iso: string,
  axisStartIso: string,
  axisEndIso: string,
  width: number,
): number {
  const start = +new Date(axisStartIso);
  const end = +new Date(axisEndIso);
  const t = +new Date(iso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(t) || end <= start) {
    return 0;
  }
  const clamped = Math.min(Math.max(t, start), end);
  return ((clamped - start) / (end - start)) * width;
}

// ── Lane assignment (portfolio lens: one lane per project) ────────────────────

/**
 * Stable lane index per project id, in first-seen order. Callers pass the
 * already-ordered project id list (TLGraph.projects is sorted by code) so
 * lane order matches the project picker / legend order everywhere else.
 */
export function laneIndexByProject(projectIds: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  let i = 0;
  for (const id of projectIds) {
    if (!map.has(id)) {
      map.set(id, i);
      i++;
    }
  }
  return map;
}

// ── DAG leveling (dependency lens) ─────────────────────────────────────────────

export interface DagEdge {
  from: string;
  to: string;
}

/**
 * Longest-path layering (Kahn's algorithm, same shape as
 * `lib/schedule/cpm.ts`'s topological pass): level(node) = 0 when it has no
 * (in-set) predecessors, else 1 + max(level(predecessor)). Edges whose
 * endpoint isn't in `nodeIds` are ignored (defensive — the caller may pass a
 * capped node set).
 *
 * Cycle-safe: `task_dependencies` inserts are guarded against cycles at
 * write time (see `api/tasks/[id]/dependencies/route.ts`), but this is pure
 * layout math and must never hang or throw on bad input. Any node that never
 * reaches in-degree 0 (i.e. only reachable through a cycle) is given a
 * fallback level of `maxLeveledLevel + 1` so every id in `nodeIds` always
 * gets an entry.
 */
export function topoLevels(nodeIds: readonly string[], edges: readonly DagEdge[]): Map<string, number> {
  const ids = new Set(nodeIds);
  const validEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);

  const succs = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) {
    succs.set(id, []);
    inDegree.set(id, 0);
  }
  for (const e of validEdges) {
    succs.get(e.from)!.push(e.to);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const id of nodeIds) {
    if ((inDegree.get(id) ?? 0) === 0) {
      queue.push(id);
      level.set(id, 0);
    }
  }

  const degWork = new Map(inDegree);
  let head = 0;
  let processed = 0;
  while (head < queue.length) {
    const u = queue[head++];
    processed++;
    const lu = level.get(u) ?? 0;
    for (const v of succs.get(u) ?? []) {
      const remaining = (degWork.get(v) ?? 0) - 1;
      degWork.set(v, remaining);
      level.set(v, Math.max(level.get(v) ?? 0, lu + 1));
      if (remaining === 0) queue.push(v);
    }
  }

  // Fallback: any id never dequeued (only reachable through a cycle) —
  // place it one level past the deepest resolved level so it still renders.
  if (processed < nodeIds.length) {
    let maxLevel = 0;
    for (const lv of level.values()) if (lv > maxLevel) maxLevel = lv;
    for (const id of nodeIds) {
      if (!level.has(id)) level.set(id, maxLevel + 1);
    }
  }

  return level;
}

export interface DagPosition {
  x: number;
  y: number;
  level: number;
}

/**
 * Full x/y layout for the dependency-lens DAG: x = level * colGap, y =
 * centered offset within its level (rowGap apart). Pure grid layout — no
 * force simulation, no new chart dependency (matches the gantt.tsx idiom of
 * plain inline SVG + arithmetic).
 */
export function packDagPositions(
  nodeIds: readonly string[],
  edges: readonly DagEdge[],
  opts: { colGap?: number; rowGap?: number } = {},
): Map<string, DagPosition> {
  const colGap = opts.colGap ?? 180;
  const rowGap = opts.rowGap ?? 44; // R-63: also the min interactive-node spacing

  const levels = topoLevels(nodeIds, edges);
  const byLevel = new Map<number, string[]>();
  for (const id of nodeIds) {
    const lv = levels.get(id) ?? 0;
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv)!.push(id);
  }

  const positions = new Map<string, DagPosition>();
  for (const [lv, ids] of byLevel) {
    ids.forEach((id, i) => {
      const yOffset = (i - (ids.length - 1) / 2) * rowGap;
      positions.set(id, { x: lv * colGap, y: yOffset, level: lv });
    });
  }
  return positions;
}

// ── Label-density cap (perf guard) ─────────────────────────────────────────────

/**
 * Returns a `count`-length boolean array marking which node indices get a
 * visible text label — always includes the first and last, otherwise evenly
 * spaced so a workspace with hundreds of nodes never lays out hundreds of
 * <text> elements. Every node still gets its (cheap) mark/dot regardless —
 * this only caps the expensive part (text).
 */
export function capLabels(count: number, max: number): boolean[] {
  if (count <= 0) return [];
  if (max <= 0) return new Array(count).fill(false);
  if (count <= max) return new Array(count).fill(true);

  const result = new Array(count).fill(false);
  const step = (count - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    const idx = Math.min(Math.round(i * step), count - 1);
    result[idx] = true;
  }
  return result;
}

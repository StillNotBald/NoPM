/**
 * Critical Path Method (CPM) — pure, side-effect-free.
 *
 * Ported and adapted from a prior PMO tool's CPM utils.
 * Works on NoPM's relational data shapes (tasks array + flat deps array)
 * rather than that tool's nested JSON. No I/O, no React, no Next.js — safe
 * to import on the client or server.
 */

// ── Input shapes ──────────────────────────────────────────────────────────────

export interface CpmInputTask {
  id: string;
  start_date: string | null;
  due_date: string | null;
}

export interface CpmInputDep {
  predecessor_id: string;
  successor_id: string;
  /** FS | SS | FF | SF — only FS is used for the forward/backward pass;
   *  the others would require a full activity-on-node expansion.
   *  For v1 we treat all types as Finish-to-Start. */
  type: "FS" | "SS" | "FF" | "SF";
  lag_days: number;
}

// ── Output shape ──────────────────────────────────────────────────────────────

export interface CpmResult {
  id: string;
  /** Duration in whole days (≥0) */
  durationDays: number;
  /** Forward-pass: earliest possible start (offset from project start, in days) */
  earlyStart: number;
  /** Forward-pass: earliest possible finish */
  earlyFinish: number;
  /** Backward-pass: latest allowable start without delaying the project */
  lateStart: number;
  /** Backward-pass: latest allowable finish */
  lateFinish: number;
  /** Total float = lateStart − earlyStart (0 ⟹ critical) */
  slack: number;
  /** true when slack ≈ 0 (within rounding tolerance of 1 day) */
  isCritical: boolean;
}

// ── Pure CPM implementation ───────────────────────────────────────────────────

/**
 * Calculate CPM data for a list of tasks with their dependencies.
 *
 * @param tasks   Array of tasks that carry date information.
 * @param deps    All task_dependency rows (flat join table records).
 * @returns       One CpmResult per task, keyed by the same id.
 *
 * The forward/backward pass uses day-offsets (integers) relative to the
 * earliest task start in the set. This is unit-safe and avoids timezone
 * arithmetic that would plague Date math.
 */
export function calculateCriticalPath(
  tasks: CpmInputTask[],
  deps: CpmInputDep[],
): CpmResult[] {
  if (tasks.length === 0) return [];

  const MS_PER_DAY = 86_400_000;

  /** Safely convert an ISO date string to a UTC day number (days since epoch). */
  function toDayNumber(iso: string | null): number | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return Math.floor(d.getTime() / MS_PER_DAY);
  }

  // ── 1. Build working task map ─────────────────────────────────────────────

  const taskSet = new Set(tasks.map((t) => t.id));

  // Filter deps to only those whose both ends are in the current task set
  const validDeps = deps.filter(
    (d) => taskSet.has(d.predecessor_id) && taskSet.has(d.successor_id),
  );

  // Compute duration in days for each task
  const durationMap = new Map<string, number>();
  for (const t of tasks) {
    const s = toDayNumber(t.start_date);
    const e = toDayNumber(t.due_date);
    const dur = s !== null && e !== null ? Math.max(e - s, 0) : 0;
    durationMap.set(t.id, dur);
  }

  // ── 2. Build adjacency structure ──────────────────────────────────────────

  const successorsOf = new Map<string, string[]>();
  const predecessorsOf = new Map<string, string[]>();
  const lagBetween = new Map<string, number>(); // key: `${predId}→${succId}`
  const inDegree = new Map<string, number>();

  for (const t of tasks) {
    successorsOf.set(t.id, []);
    predecessorsOf.set(t.id, []);
    inDegree.set(t.id, 0);
  }

  for (const d of validDeps) {
    successorsOf.get(d.predecessor_id)!.push(d.successor_id);
    predecessorsOf.get(d.successor_id)!.push(d.predecessor_id);
    inDegree.set(d.successor_id, (inDegree.get(d.successor_id) ?? 0) + 1);
    lagBetween.set(`${d.predecessor_id}→${d.successor_id}`, d.lag_days ?? 0);
  }

  // ── 3. Topological sort (Kahn's algorithm) ────────────────────────────────

  const sorted: string[] = [];
  const queue: string[] = [];

  inDegree.forEach((deg, id) => {
    if (deg === 0) queue.push(id);
  });

  while (queue.length > 0) {
    const u = queue.shift()!;
    sorted.push(u);
    for (const v of successorsOf.get(u) ?? []) {
      const newDeg = (inDegree.get(v) ?? 0) - 1;
      inDegree.set(v, newDeg);
      if (newDeg === 0) queue.push(v);
    }
  }

  // If a cycle existed, sorted will be shorter than tasks.length.
  // Fall back to the original order so we still return a result for every task.
  const processOrder =
    sorted.length === tasks.length ? sorted : tasks.map((t) => t.id);

  // ── 4. Forward pass ───────────────────────────────────────────────────────

  const earlyStart = new Map<string, number>();
  const earlyFinish = new Map<string, number>();

  for (const id of processOrder) {
    const preds = predecessorsOf.get(id) ?? [];
    let es = 0;
    for (const predId of preds) {
      const ef = earlyFinish.get(predId) ?? 0;
      const lag = lagBetween.get(`${predId}→${id}`) ?? 0;
      const candidate = ef + lag;
      if (candidate > es) es = candidate;
    }
    const dur = durationMap.get(id) ?? 0;
    earlyStart.set(id, es);
    earlyFinish.set(id, es + dur);
  }

  // Project finish = max early finish across all tasks
  let projectFinish = 0;
  earlyFinish.forEach((ef) => {
    if (ef > projectFinish) projectFinish = ef;
  });

  // ── 5. Backward pass ──────────────────────────────────────────────────────

  const lateStart = new Map<string, number>();
  const lateFinish = new Map<string, number>();

  // Reverse topological order
  const reverseOrder = [...processOrder].reverse();

  for (const id of reverseOrder) {
    const succs = successorsOf.get(id) ?? [];
    let lf = projectFinish;
    for (const succId of succs) {
      const ls = lateStart.get(succId) ?? projectFinish;
      const lag = lagBetween.get(`${id}→${succId}`) ?? 0;
      const candidate = ls - lag;
      if (candidate < lf) lf = candidate;
    }
    const dur = durationMap.get(id) ?? 0;
    lateFinish.set(id, lf);
    lateStart.set(id, lf - dur);
  }

  // ── 6. Assemble results ───────────────────────────────────────────────────

  return tasks.map((t) => {
    const es = earlyStart.get(t.id) ?? 0;
    const ef = earlyFinish.get(t.id) ?? 0;
    const ls = lateStart.get(t.id) ?? 0;
    const lf = lateFinish.get(t.id) ?? 0;
    const slack = ls - es;
    return {
      id: t.id,
      durationDays: durationMap.get(t.id) ?? 0,
      earlyStart: es,
      earlyFinish: ef,
      lateStart: ls,
      lateFinish: lf,
      slack,
      // Treat as critical when slack rounds to 0 within ±1 day tolerance
      isCritical: Math.abs(slack) < 1,
    };
  });
}

/**
 * Build a lookup map of task id → CpmResult for O(1) access in renderers.
 */
export function toCpmMap(results: CpmResult[]): Map<string, CpmResult> {
  return new Map(results.map((r) => [r.id, r]));
}

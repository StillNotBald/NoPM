/**
 * Critical Path Method (CPM) — pure, side-effect-free.
 *
 * Standard textbook method (PMBOK / precedence diagramming):
 *   1. order the activities topologically (Kahn's algorithm),
 *   2. forward pass  -> earliest start (ES) / earliest finish (EF),
 *   3. backward pass -> latest start (LS) / latest finish (LF),
 *   4. total float = LS - ES; an activity is critical when its float is 0.
 * Precedence relationships FS / SS / FF / SF with positive (lag) or negative
 * (lead) offsets are honoured in both passes.
 *
 * Works on NoPM's relational data shapes (tasks array + flat deps array).
 * No I/O, no React, no Next.js — safe to import on the client or server.
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
  /** Precedence relationship: Finish-to-Start, Start-to-Start,
   *  Finish-to-Finish or Start-to-Finish. */
  type: "FS" | "SS" | "FF" | "SF";
  /** Offset in days applied to the relationship (negative = lead). */
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

/** ISO date string -> whole UTC day number, or null when absent/unparseable. */
function dayNumber(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / MS_PER_DAY);
}

/** An edge as seen from the node being processed. */
interface Edge {
  /** The task on the other end of the relationship. */
  other: string;
  type: CpmInputDep["type"];
  lag: number;
}

/**
 * Kahn's algorithm. Returns node ids in topological order, or null when the
 * graph contains a cycle (the sort cannot consume every node).
 */
function topologicalOrder(
  ids: string[],
  outgoing: Map<string, Edge[]>,
): string[] | null {
  const remaining = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const id of ids) {
    for (const e of outgoing.get(id)!) {
      remaining.set(e.other, remaining.get(e.other)! + 1);
    }
  }
  const ready = ids.filter((id) => remaining.get(id) === 0);
  const order: string[] = [];
  for (let head = 0; head < ready.length; head++) {
    const id = ready[head];
    order.push(id);
    for (const e of outgoing.get(id)!) {
      const left = remaining.get(e.other)! - 1;
      remaining.set(e.other, left);
      if (left === 0) ready.push(e.other);
    }
  }
  return order.length === ids.length ? order : null;
}

// ── Pure CPM implementation ───────────────────────────────────────────────────

/**
 * Calculate CPM data for a list of tasks with their dependencies.
 *
 * @param tasks   Array of tasks that carry date information.
 * @param deps    All task_dependency rows (flat join table records).
 * @returns       One CpmResult per task, in input order.
 *
 * Times are integer day offsets from the project start (not calendar dates),
 * which keeps the arithmetic free of timezone effects. A task's duration is
 * due − start; its calendar position does not seed the forward pass.
 *
 * If the graph contains a cycle no topological order exists; the tasks are
 * then processed in input order and not-yet-computed neighbours are skipped,
 * so a result is still returned for every task.
 */
export function calculateCriticalPath(
  tasks: CpmInputTask[],
  deps: CpmInputDep[],
): CpmResult[] {
  if (tasks.length === 0) return [];

  const ids = tasks.map((t) => t.id);
  const known = new Set(ids);

  const duration = new Map<string, number>();
  for (const t of tasks) {
    const s = dayNumber(t.start_date);
    const e = dayNumber(t.due_date);
    duration.set(t.id, s !== null && e !== null ? Math.max(e - s, 0) : 0);
  }

  // Edge lists in both directions; relationships touching unknown tasks drop.
  const outgoing = new Map<string, Edge[]>(ids.map((id) => [id, []]));
  const incoming = new Map<string, Edge[]>(ids.map((id) => [id, []]));
  for (const d of deps) {
    if (!known.has(d.predecessor_id) || !known.has(d.successor_id)) continue;
    const lag = d.lag_days ?? 0;
    outgoing.get(d.predecessor_id)!.push({ other: d.successor_id, type: d.type, lag });
    incoming.get(d.successor_id)!.push({ other: d.predecessor_id, type: d.type, lag });
  }

  const order = topologicalOrder(ids, outgoing) ?? ids;

  // Forward pass. Each relationship yields a lower bound on the successor's
  // early start:
  //   FS: ES(s) >= EF(p) + lag      SS: ES(s) >= ES(p) + lag
  //   FF: EF(s) >= EF(p) + lag      SF: EF(s) >= ES(p) + lag
  // and EF = ES + duration, so the FF/SF bounds are shifted back by duration(s).
  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  for (const id of order) {
    const dur = duration.get(id)!;
    let start = 0;
    for (const e of incoming.get(id)!) {
      const pES = es.get(e.other);
      const pEF = ef.get(e.other);
      if (pES === undefined || pEF === undefined) continue; // not yet computed (cycle)
      let bound: number;
      switch (e.type) {
        case "SS": bound = pES + e.lag; break;
        case "FF": bound = pEF + e.lag - dur; break;
        case "SF": bound = pES + e.lag - dur; break;
        default:   bound = pEF + e.lag; // FS
      }
      if (bound > start) start = bound;
    }
    es.set(id, start);
    ef.set(id, start + dur);
  }

  let projectFinish = 0;
  for (const v of ef.values()) if (v > projectFinish) projectFinish = v;

  // Backward pass, in reverse order. Upper bounds on the predecessor p from
  // successor s (LS/LF already known for s):
  //   FS: LF(p) <= LS(s) - lag      SS: LS(p) <= LS(s) - lag
  //   FF: LF(p) <= LF(s) - lag      SF: LS(p) <= LF(s) - lag
  // and LS = LF - duration, so the SS/SF bounds are shifted up by duration(p).
  const ls = new Map<string, number>();
  const lf = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const dur = duration.get(id)!;
    let finish = projectFinish;
    for (const e of outgoing.get(id)!) {
      const sLS = ls.get(e.other);
      const sLF = lf.get(e.other);
      if (sLS === undefined || sLF === undefined) continue; // not yet computed (cycle)
      let bound: number;
      switch (e.type) {
        case "SS": bound = sLS - e.lag + dur; break;
        case "FF": bound = sLF - e.lag; break;
        case "SF": bound = sLF - e.lag + dur; break;
        default:   bound = sLS - e.lag; // FS
      }
      if (bound < finish) finish = bound;
    }
    lf.set(id, finish);
    ls.set(id, finish - dur);
  }

  return tasks.map((t) => {
    const slack = ls.get(t.id)! - es.get(t.id)!;
    return {
      id: t.id,
      durationDays: duration.get(t.id)!,
      earlyStart: es.get(t.id)!,
      earlyFinish: ef.get(t.id)!,
      lateStart: ls.get(t.id)!,
      lateFinish: lf.get(t.id)!,
      slack,
      // Critical when total float is zero (tolerance: under one whole day).
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

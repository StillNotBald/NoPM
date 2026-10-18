/**
 * Flow metrics (L-22/L-24/L-26) — cycle time, lead time, and per-task
 * time-in-status, all derived from the SAME ordered `audit_log` transition
 * sequence used by `status-age.ts` and `burndown.ts`, but retaining the
 * FULL sequence per task rather than only the last transition (the gap
 * `status-age.ts` calls out for itself).
 *
 * Definitions:
 *  - cycle time  = first entry into status_type 'started' → the task's
 *    completion. A task CREATED directly in 'started' (its `task.create`
 *    row already carries `after.status_type === 'started'`) uses that
 *    create timestamp as the cycle start — there is no separate "entered
 *    started" transition to find. A task that never enters 'started' at
 *    all (e.g. backlog → completed) has NO cycle start and is excluded
 *    from cycle time (`cycleExcludedReason: "skipped-started"`).
 *  - lead time   = task creation (`created_at`) → the task's completion.
 *  - "the task's completion", for BOTH metrics, is the LATEST transition
 *    into status_type 'completed'. For a task completed exactly once this
 *    is also the first (and only) completion; for a REOPENED task (moved
 *    off 'completed' and completed again later) this deliberately uses the
 *    final completion rather than the first — the work wasn't actually
 *    done until the last time it was marked done. Document this choice in
 *    any UI caption that surfaces these numbers.
 *  - a task with no completion transition at all is "incomplete" and is
 *    excluded from BOTH cycle and lead time (`..ExcludedReason: "incomplete"`)
 *    — unless it also never entered 'started', in which case cycle time
 *    reports "skipped-started" (the more specific reason) instead.
 *  - a task with literally zero transition rows (no `task.create` row
 *    either — a defensive edge case, e.g. an audit gap) is excluded from
 *    both metrics with reason "no-transitions", rather than crashing.
 *
 * `timeInStatus` turns one task's ordered transitions into a span per
 * status_type occupied (entered_at/exited_at/hours), with the final span
 * left open (`exited_at: null`) and its `hours` measured against `now`.
 *
 * All aggregation (median/p85) here is over HOURS — the UI layer is free to
 * reformat (e.g. hours → days) for display; this module picks no display
 * unit beyond the one `timeInStatus`'s spec explicitly names ("hours").
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface TaskForFlow {
  id: string;
  project_id: string;
  /** Sprint the task is currently attached to, if any. */
  sprint_id?: string | null;
  /** ISO timestamp — the lead-time anchor. */
  created_at: string;
}

export interface AuditRowForFlow {
  target_id: string | null;
  /** Only "task.create" and "task.update" rows are meaningful here. */
  action: string;
  before: unknown;
  after: unknown;
  /** ISO timestamp of the audit row. */
  created_at: string;
}

export interface StatusSpan {
  status_type: string;
  /** ISO timestamp the task entered this status. */
  entered_at: string;
  /** ISO timestamp the task left this status, or null while still current. */
  exited_at: string | null;
  /** Duration of the span in hours (against `now` while still open). */
  hours: number;
}

export type CycleExclusionReason = "skipped-started" | "incomplete" | "no-transitions";
export type LeadExclusionReason = "incomplete" | "no-transitions";

export interface TaskFlowResult {
  task_id: string;
  cycleTimeHours: number | null;
  cycleExcludedReason: CycleExclusionReason | null;
  leadTimeHours: number | null;
  leadExcludedReason: LeadExclusionReason | null;
}

export interface FlowAggregate {
  /** Total tasks considered for this group (completed + excluded). */
  sampleSize: number;
  cycleTimeHoursMedian: number | null;
  cycleTimeHoursP85: number | null;
  cycleExcludedCount: number;
  leadTimeHoursMedian: number | null;
  leadTimeHoursP85: number | null;
  leadExcludedCount: number;
}

export interface FlowResult {
  tasks: TaskFlowResult[];
  byProject: Map<string, FlowAggregate>;
  bySprint: Map<string, FlowAggregate>;
}

function statusTypeOf(row: unknown): string | undefined {
  if (row && typeof row === "object" && "status_type" in row) {
    const v = (row as Record<string, unknown>).status_type;
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function hoursBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, (to - from) / (60 * 60 * 1000));
}

function sortByCreatedAt(rows: readonly AuditRowForFlow[]): AuditRowForFlow[] {
  return [...rows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

/**
 * Pure, per-task cycle/lead time derivation over one task's FULL ordered
 * transition sequence (any order in, sorted defensively here).
 */
function computeTaskFlow(
  taskId: string,
  createdAt: string,
  transitions: readonly AuditRowForFlow[],
): TaskFlowResult {
  if (transitions.length === 0) {
    return {
      task_id: taskId,
      cycleTimeHours: null,
      cycleExcludedReason: "no-transitions",
      leadTimeHours: null,
      leadExcludedReason: "no-transitions",
    };
  }

  const sorted = sortByCreatedAt(transitions);

  const createRow = sorted.find((r) => r.action === "task.create");
  const createdInStarted = createRow !== undefined && statusTypeOf(createRow.after) === "started";

  let cycleStart: string | null = createdInStarted ? createRow!.created_at : null;
  const completions: AuditRowForFlow[] = [];

  for (const row of sorted) {
    if (row.action !== "task.update") continue;
    const before = statusTypeOf(row.before);
    const after = statusTypeOf(row.after);
    if (before === undefined || after === undefined) continue;
    if (before === after) continue; // non-status edit (rename, reassign, ...)

    if (cycleStart === null && before !== "started" && after === "started") {
      cycleStart = row.created_at;
    }
    if (before !== "completed" && after === "completed") {
      completions.push(row);
    }
  }

  // Latest completion wins (reopen semantics) — first === latest when a task
  // was only ever completed once.
  const lastCompletion = completions.length > 0 ? completions[completions.length - 1] : null;

  let cycleTimeHours: number | null = null;
  let cycleExcludedReason: CycleExclusionReason | null = null;
  if (cycleStart === null) {
    cycleExcludedReason = "skipped-started";
  } else if (lastCompletion === null) {
    cycleExcludedReason = "incomplete";
  } else {
    cycleTimeHours = round1(hoursBetween(cycleStart, lastCompletion.created_at));
  }

  let leadTimeHours: number | null = null;
  let leadExcludedReason: LeadExclusionReason | null = null;
  if (lastCompletion === null) {
    leadExcludedReason = "incomplete";
  } else {
    leadTimeHours = round1(hoursBetween(createdAt, lastCompletion.created_at));
  }

  return { task_id: taskId, cycleTimeHours, cycleExcludedReason, leadTimeHours, leadExcludedReason };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round1(sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]);
}

/** Nearest-rank 85th percentile (undocumented upstream — fixed here, like burndown's ideal-line choice). */
function p85(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(0.85 * sorted.length)));
  return round1(sorted[rank - 1]);
}

function aggregate(results: readonly TaskFlowResult[]): FlowAggregate {
  const cycleValues = results
    .filter((r): r is TaskFlowResult & { cycleTimeHours: number } => r.cycleTimeHours !== null)
    .map((r) => r.cycleTimeHours);
  const leadValues = results
    .filter((r): r is TaskFlowResult & { leadTimeHours: number } => r.leadTimeHours !== null)
    .map((r) => r.leadTimeHours);

  return {
    sampleSize: results.length,
    cycleTimeHoursMedian: median(cycleValues),
    cycleTimeHoursP85: p85(cycleValues),
    cycleExcludedCount: results.filter((r) => r.cycleExcludedReason !== null).length,
    leadTimeHoursMedian: median(leadValues),
    leadTimeHoursP85: p85(leadValues),
    leadExcludedCount: results.filter((r) => r.leadExcludedReason !== null).length,
  };
}

/**
 * Pure derivation — no I/O. `transitionsByTask` need not cover every task in
 * `tasks` (a task with no entry is treated as zero transitions, same as an
 * empty array). Aggregates group by `project_id` (always) and by
 * `sprint_id` (only tasks currently attached to a sprint contribute).
 */
export function deriveFlow(
  tasks: readonly TaskForFlow[],
  transitionsByTask: ReadonlyMap<string, readonly AuditRowForFlow[]>,
): FlowResult {
  const results: TaskFlowResult[] = [];
  const resultByTaskId = new Map<string, TaskFlowResult>();
  for (const t of tasks) {
    const r = computeTaskFlow(t.id, t.created_at, transitionsByTask.get(t.id) ?? []);
    results.push(r);
    resultByTaskId.set(t.id, r);
  }

  const byProjectGroups = new Map<string, TaskFlowResult[]>();
  const bySprintGroups = new Map<string, TaskFlowResult[]>();
  for (const t of tasks) {
    const r = resultByTaskId.get(t.id)!;

    const pl = byProjectGroups.get(t.project_id) ?? [];
    pl.push(r);
    byProjectGroups.set(t.project_id, pl);

    if (t.sprint_id) {
      const sl = bySprintGroups.get(t.sprint_id) ?? [];
      sl.push(r);
      bySprintGroups.set(t.sprint_id, sl);
    }
  }

  const byProject = new Map<string, FlowAggregate>();
  for (const [pid, list] of byProjectGroups) byProject.set(pid, aggregate(list));

  const bySprint = new Map<string, FlowAggregate>();
  for (const [sid, list] of bySprintGroups) bySprint.set(sid, aggregate(list));

  return { tasks: results, byProject, bySprint };
}

/**
 * Pure derivation — no I/O. Turns one task's ordered transitions into a
 * span per status_type occupied. Tolerates rows with a missing/unparsable
 * status_type on either side (skipped, never crashes) and rows out of
 * order (sorted defensively). Empty input → empty output (a task with an
 * audit-trail gap renders no spans rather than throwing).
 */
export function timeInStatus(
  transitions: readonly AuditRowForFlow[],
  now: Date = new Date(),
): StatusSpan[] {
  if (transitions.length === 0) return [];

  const sorted = sortByCreatedAt(transitions);
  const spans: StatusSpan[] = [];
  let currentStatus: string | undefined;
  let enteredAt: string | undefined;

  for (const row of sorted) {
    if (row.action === "task.create") {
      const after = statusTypeOf(row.after);
      if (after === undefined) continue;
      currentStatus = after;
      enteredAt = row.created_at;
      continue;
    }
    if (row.action !== "task.update") continue;

    const before = statusTypeOf(row.before);
    const after = statusTypeOf(row.after);
    if (before === undefined || after === undefined) continue;
    if (before === after) continue; // non-status edit

    if (currentStatus === undefined || enteredAt === undefined) {
      // Defensive: the batch starts mid-history with no create row — open
      // the first span from `before` at this row's timestamp (best-effort;
      // the true entry time is unknown).
      currentStatus = before;
      enteredAt = row.created_at;
    }

    spans.push({
      status_type: currentStatus,
      entered_at: enteredAt,
      exited_at: row.created_at,
      hours: round1(hoursBetween(enteredAt, row.created_at)),
    });

    currentStatus = after;
    enteredAt = row.created_at;
  }

  if (currentStatus !== undefined && enteredAt !== undefined) {
    spans.push({
      status_type: currentStatus,
      entered_at: enteredAt,
      exited_at: null,
      hours: round1(hoursBetween(enteredAt, now.toISOString())),
    });
  }

  return spans;
}

/**
 * DB-touching half: fetch every `task.create`/`task.update` audit row for
 * the given task ids (or the whole workspace when omitted) in ONE query,
 * grouped by target_id, ascending by created_at. Always filters by
 * `workspace_id` explicitly (safe/redundant under an RLS session client;
 * REQUIRED when called with the admin client, as GET
 * /api/metrics/time-in-status does). Fail-soft — a read-only insight
 * returns an empty map on error rather than breaking the caller.
 */
export async function fetchTaskTransitions(
  db: SupabaseClient,
  workspaceId: string,
  taskIds?: readonly string[],
): Promise<Map<string, AuditRowForFlow[]>> {
  if (taskIds !== undefined && taskIds.length === 0) return new Map();

  let query = db
    .from("audit_log")
    .select("target_id, action, before, after, created_at")
    .eq("workspace_id", workspaceId)
    .eq("target_type", "task")
    .in("action", ["task.create", "task.update"])
    .order("created_at", { ascending: true });

  if (taskIds !== undefined) query = query.in("target_id", taskIds);

  const { data, error } = await query;
  if (error) return new Map();

  const grouped = new Map<string, AuditRowForFlow[]>();
  for (const row of (data ?? []) as AuditRowForFlow[]) {
    if (!row.target_id) continue;
    const list = grouped.get(row.target_id) ?? [];
    list.push(row);
    grouped.set(row.target_id, list);
  }
  return grouped;
}

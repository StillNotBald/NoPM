/**
 * Nightly project snapshots (audit gap B6).
 *
 * One `project_snapshots` row per project per day: the numbers a trend needs
 * (SPI, CPI, EAC, planned vs forecast end, slip, completion, open high risks) plus
 * the declared RAG and the RAG the trend rules suggest. Taken by the snapshot cron
 * (/api/cron/snapshots) with the service role.
 *
 * Idempotent: the (project_id, taken_at) unique key plus `on conflict do nothing` (inside nopm_snapshot_run) means a
 * second run on the same day inserts nothing. Each run still writes exactly ONE
 * `snapshot.taken` audit row per workspace it touched, carrying the counts
 * (projects seen, snapshots taken, already there), so a re-run is visible, not silent.
 *
 * Dates:
 *   planned_end  = the baseline finish (projects.baseline_target_date).
 *   forecast_end = the later of the current finish (projects.target_date) and the
 *                  SPI-projected finish (baseline start + baseline duration / SPI),
 *                  so the forecast moves as work falls behind even when nobody edits
 *                  a date. Null when the project has no baseline finish.
 *   slip_days    = forecast_end − planned_end in calendar days (negative = ahead).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { systemActor } from "@/lib/audit/write";
import { buildRpcAudit } from "@/lib/audit/sql-audit-insert";
import { computeEvm } from "@/lib/evm";
import { workspaceToday } from "@/lib/integrations/time-zone";
import { computeTrend, normalizeSeries, TREND_WINDOW, type SnapshotPoint } from "@/lib/insight/trend";

type Db = ReturnType<typeof createAdminClient>;

export const SNAPSHOT_AUDIT_ACTION = "snapshot.taken";

const DAY_MS = 86_400_000;
const PAGE = 1000;
const ID_CHUNK = 100;
type Row = Record<string, unknown>;

interface ProjectRow {
  id: string;
  workspace_id: string;
  completion_pct: number | null;
  baseline_start_date: string | null;
  baseline_target_date: string | null;
  target_date: string | null;
  rag_status: string | null;
}

export interface SnapshotRow {
  workspace_id: string;
  project_id: string;
  taken_at: string;
  spi: number | null;
  cpi: number | null;
  eac: number | null;
  planned_end: string | null;
  forecast_end: string | null;
  slip_days: number | null;
  completion_pct: number;
  open_risks_high: number;
  rag_declared: string | null;
  rag_suggested: string | null;
}

export interface SnapshotRunSummary {
  workspaces: number;
  projects: number;
  taken: number;
  skipped: number;
}

function day(iso: string): number {
  return Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}
function isoOf(dayNumber: number): string {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}
const round3 = (n: number | null) => (n === null ? null : Math.round(n * 1000) / 1000);

/** Pure: forecast end and slip for one project (see the file comment). */
export function forecastDates(
  p: Pick<ProjectRow, "baseline_start_date" | "baseline_target_date" | "target_date">,
  spi: number | null,
): { planned_end: string | null; forecast_end: string | null; slip_days: number | null } {
  if (!p.baseline_target_date) return { planned_end: null, forecast_end: null, slip_days: null };
  const planned = day(p.baseline_target_date);
  let forecast = p.target_date ? day(p.target_date) : planned;
  if (p.baseline_start_date && spi !== null && spi > 0) {
    const start = day(p.baseline_start_date);
    const duration = planned - start;
    if (duration > 0) forecast = Math.max(forecast, Math.round(start + duration / spi));
  }
  return {
    planned_end: p.baseline_target_date.slice(0, 10),
    forecast_end: isoOf(forecast),
    slip_days: forecast - planned,
  };
}

/** Pure: build one snapshot row. `history` is the project's earlier snapshots (any order). */
export function buildSnapshot(input: {
  project: ProjectRow;
  budget: { planned_amount: number; committed_amount: number; estimate_to_complete: number | null; committed_open?: number | null; forecast_method: string | null } | null;
  actual: number;
  openRisksHigh: number;
  today: string;
  history: readonly SnapshotPoint[];
}): SnapshotRow {
  const { project, budget, actual, openRisksHigh, today, history } = input;
  const evm = computeEvm({
    planned_amount: Number(budget?.planned_amount ?? 0),
    completion_pct: Number(project.completion_pct ?? 0),
    committed_amount: Number(budget?.committed_amount ?? 0),
    actual_amount: actual,
    baseline_start_date: project.baseline_start_date,
    baseline_target_date: project.baseline_target_date,
    as_of_date: today,
    estimate_to_complete: budget?.estimate_to_complete ?? null,
    committed_open: budget?.committed_open ?? null,
    forecast_method: budget?.forecast_method === "bottom_up" ? "bottom_up" : "cpi",
  });
  const dates = forecastDates(project, evm.spi);
  const completion = Math.max(0, Math.min(100, Number(project.completion_pct ?? 0)));
  const row: SnapshotRow = {
    workspace_id: project.workspace_id,
    project_id: project.id,
    taken_at: today,
    spi: round3(evm.spi),
    cpi: round3(evm.cpi),
    eac: evm.eac === null ? null : Math.round(evm.eac * 100) / 100,
    ...dates,
    completion_pct: completion,
    open_risks_high: openRisksHigh,
    rag_declared: project.rag_status,
    rag_suggested: null,
  };
  // The suggestion reads the history PLUS this snapshot, so it is stored with the row.
  const trend = computeTrend([...history, { ...row, taken_at: today }], TREND_WINDOW);
  row.rag_suggested = trend.suggested_rag;
  return row;
}

/**
 * Read every row of a query in chunks of PAGE (PostgREST caps one response at 1000 rows,
 * so an unpaged read silently drops the rest). `build` must return a FRESH query each call;
 * the order column must be unique-ish so pages do not overlap.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readAll(name: string, build: () => any, orderCol: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().order(orderCol, { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`snapshots: ${name} query failed: ${error.message}`);
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function allProjects(db: Db, workspaceId?: string): Promise<ProjectRow[]> {
  const out: ProjectRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = db
      .from("projects")
      .select("id, workspace_id, completion_pct, baseline_start_date, baseline_target_date, target_date, rag_status")
      .order("id")
      .range(from, from + PAGE - 1);
    if (workspaceId) q = q.eq("workspace_id", workspaceId);
    const { data, error } = await q;
    if (error) throw new Error(`snapshots: projects query failed: ${error.message}`);
    const rows = (data ?? []) as ProjectRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * Take today's snapshot of every project (optionally one workspace). Safe to run
 * any number of times a day. A failing query throws (the cron answers 500): an
 * absent snapshot must never look like a quiet project.
 */
export async function takeSnapshots(
  db: Db = createAdminClient(),
  opts: { workspaceId?: string; now?: Date } = {},
): Promise<SnapshotRunSummary> {
  const projects = await allProjects(db, opts.workspaceId);
  const byWorkspace = new Map<string, ProjectRow[]>();
  for (const p of projects) {
    const list = byWorkspace.get(p.workspace_id) ?? [];
    list.push(p);
    byWorkspace.set(p.workspace_id, list);
  }

  const summary: SnapshotRunSummary = { workspaces: 0, projects: 0, taken: 0, skipped: 0 };

  for (const [workspaceId, list] of byWorkspace) {
    const today = await workspaceToday(workspaceId, opts.now);
    const ids = list.map((p) => p.id);

    // Every read is paged (chunks of 1000 rows, ids in chunks of 100): one unpaged read would
    // silently drop rows past PostgREST's cap and store a low actual and a wrong CPI.
    const sinceDay = isoOf(day(today) - (TREND_WINDOW + 7));
    const inIds = async (name: string, build: (chunk: string[]) => unknown, orderCol: string): Promise<Row[]> => {
      const out: Row[] = [];
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        const chunk = ids.slice(i, i + ID_CHUNK);
        out.push(...(await readAll(name, () => build(chunk), orderCol)));
      }
      return out;
    };
    const budgets = await inIds(
      "budget",
      (chunk) =>
        db
          .from("project_budget")
          .select("project_id, planned_amount, committed_amount, committed_open, estimate_to_complete, forecast_method")
          .eq("workspace_id", workspaceId)
          .in("project_id", chunk),
      "project_id",
    );
    const expenses = await inIds(
      "expenses",
      (chunk) => db.from("expenses").select("id, project_id, amount").eq("workspace_id", workspaceId).in("project_id", chunk),
      "id",
    );
    const risks = await inIds(
      "risks",
      (chunk) =>
        db
          .from("risks")
          .select("id, project_id")
          .eq("workspace_id", workspaceId)
          .in("project_id", chunk)
          .in("status", ["open", "mitigating"])
          .in("severity", ["high", "critical"]),
      "id",
    );
    // Only the trend window is needed, so the read is bounded by date, then paged.
    const history = await inIds(
      "history",
      (chunk) =>
        db
          .from("project_snapshots")
          .select("id, project_id, taken_at, spi, cpi, eac, slip_days, completion_pct, open_risks_high, rag_declared")
          .eq("workspace_id", workspaceId)
          .in("project_id", chunk)
          .gte("taken_at", sinceDay)
          .lt("taken_at", today),
      "id",
    );

    const budgetOf = new Map<string, NonNullable<Parameters<typeof buildSnapshot>[0]["budget"]>>();
    for (const b of (budgets) as Array<Record<string, unknown>>) {
      budgetOf.set(b.project_id as string, {
        planned_amount: Number(b.planned_amount ?? 0),
        committed_amount: Number(b.committed_amount ?? 0),
        estimate_to_complete: b.estimate_to_complete == null ? null : Number(b.estimate_to_complete),
        committed_open: b.committed_open == null ? null : Number(b.committed_open),
        forecast_method: (b.forecast_method as string | null) ?? null,
      });
    }
    const spent = new Map<string, number>();
    for (const e of (expenses as unknown as Array<{ project_id: string; amount: number | null }>) as Array<{ project_id: string; amount: number | null }>) {
      spent.set(e.project_id, (spent.get(e.project_id) ?? 0) + Number(e.amount ?? 0));
    }
    const highRisks = new Map<string, number>();
    for (const r of (risks as unknown as Array<{ project_id: string }>) as Array<{ project_id: string }>) {
      highRisks.set(r.project_id, (highRisks.get(r.project_id) ?? 0) + 1);
    }
    const historyOf = new Map<string, SnapshotPoint[]>();
    for (const h of (history as unknown as Array<SnapshotPoint & { project_id: string }>) as Array<SnapshotPoint & { project_id: string }>) {
      const arr = historyOf.get(h.project_id) ?? [];
      arr.push(h);
      historyOf.set(h.project_id, arr);
    }

    const rows = list.map((project) =>
      buildSnapshot({
        project,
        budget: budgetOf.get(project.id) ?? null,
        actual: spent.get(project.id) ?? 0,
        openRisksHigh: highRisks.get(project.id) ?? 0,
        today,
        history: normalizeSeries(historyOf.get(project.id) ?? [], TREND_WINDOW),
      }),
    );

    // One transaction per workspace (R-165): the run's snapshot rows (on conflict do nothing, so a second
    // run the same day adds none) and the ONE snapshot.taken audit row, written with the system actor.
    const { data: ran, error } = await db.rpc("nopm_snapshot_run", {
      p_workspace_id: workspaceId,
      p_taken_at: today,
      p_rows: rows,
      p_audit: buildRpcAudit(
        systemActor(workspaceId, "snapshots", { channel: "api" }),
        SNAPSHOT_AUDIT_ACTION,
        "workspace",
        {},
        workspaceId,
      ),
    });
    if (error) throw new Error(`snapshots: write failed: ${error.message}`);
    const taken = Number((ran as { taken?: number } | null)?.taken ?? 0);
    const skipped = rows.length - taken;

    summary.workspaces += 1;
    summary.projects += rows.length;
    summary.taken += taken;
    summary.skipped += skipped;
  }
  return summary;
}

import { describe, it, expect, vi, beforeEach } from "vitest";

const { writeAuditMock } = vi.hoisted(() => ({
  writeAuditMock: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/audit/write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit/write")>()),
  writeAudit: writeAuditMock,
}));
vi.mock("@/lib/integrations/time-zone", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/time-zone")>()),
  workspaceToday: async () => "2026-10-18",
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import { buildSnapshot, forecastDates, takeSnapshots } from "./snapshots";

type Row = Record<string, unknown>;

/** A small stateful stand-in for the admin client: filters, upsert with ignoreDuplicates. */
function memoryDb(tables: Record<string, Row[]>, maxRows = Infinity) {
  const writes: Array<{ table: string; rows: Row[] }> = [];
  return {
    writes,
    client: {
      from(table: string) {
        const filters: Array<(r: Row) => boolean> = [];
        let order: { col: string; asc: boolean } | null = null;
        let limit = Infinity;
        let range: [number, number] | null = null;
        let upsert: { rows: Row[]; keys: string[]; ignore: boolean } | null = null;
        const b: Record<string, unknown> = {};
        b.select = () => b;
        b.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), b);
        b.in = (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b);
        b.lt = (c: string, v: string) => (filters.push((r) => String(r[c]) < v), b);
        b.gte = (c: string, v: string) => (filters.push((r) => String(r[c]) >= v), b);
        b.order = (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending !== false }), b);
        b.limit = (n: number) => ((limit = n), b);
        b.range = (a: number, z: number) => ((range = [a, z]), b);
        b.upsert = (rows: Row[], opts: { onConflict: string; ignoreDuplicates?: boolean }) => {
          upsert = { rows, keys: opts.onConflict.split(","), ignore: opts.ignoreDuplicates === true };
          return b;
        };
        b.then = (resolve: (v: unknown) => unknown) => {
          const store = (tables[table] ??= []);
          if (upsert) {
            const added: Row[] = [];
            for (const row of upsert.rows) {
              const dupe = store.some((s) => upsert!.keys.every((k) => s[k] === row[k]));
              if (dupe && upsert.ignore) continue;
              store.push({ id: `${table}-${store.length + 1}`, ...row });
              added.push(row);
            }
            writes.push({ table, rows: added });
            return Promise.resolve({ data: added.map((r) => ({ id: r.project_id })), error: null }).then(resolve);
          }
          let rows = store.filter((r) => filters.every((f) => f(r)));
          if (order) {
            const { col, asc } = order;
            rows = [...rows].sort((x, y) => (String(x[col]) === String(y[col]) ? 0 : String(x[col]) < String(y[col]) ? -1 : 1) * (asc ? 1 : -1));
          }
          if (range) rows = rows.slice(range[0], range[1] + 1);
          rows = rows.slice(0, Math.min(limit, maxRows));
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        };
        return b;
      },
    } as never,
  };
}

const WS = "ws-1";
const project = (id: string, over: Row = {}): Row => ({
  id,
  workspace_id: WS,
  completion_pct: 40,
  baseline_start_date: "2026-09-01",
  baseline_target_date: "2026-12-31",
  target_date: "2026-12-31",
  rag_status: "green",
  ...over,
});

beforeEach(() => writeAuditMock.mockClear());

describe("takeSnapshots", () => {
  it("takes one snapshot per project and writes ONE audit row for the run", async () => {
    const db = memoryDb({
      projects: [project("p1"), project("p2")],
      project_budget: [{ workspace_id: WS, project_id: "p1", planned_amount: 1000, committed_amount: 100, estimate_to_complete: null, forecast_method: "cpi" }],
      expenses: [{ workspace_id: WS, project_id: "p1", amount: 300 }],
      risks: [{ workspace_id: WS, project_id: "p1", status: "open", severity: "high" }],
    });
    const out = await takeSnapshots(db.client);
    expect(out).toEqual({ workspaces: 1, projects: 2, taken: 2, skipped: 0 });
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const audit = writeAuditMock.mock.calls[0][0] as { action: string; workspaceId: string; after: Record<string, unknown> };
    expect(audit.action).toBe("snapshot.taken");
    expect(audit.workspaceId).toBe(WS);
    expect(audit.after).toMatchObject({ taken_at: "2026-10-18", projects: 2, taken: 2, already_taken: 0 });
  });

  it("is idempotent: a second run the same day adds no snapshot and still writes one audit row", async () => {
    const tables: Record<string, Row[]> = { projects: [project("p1"), project("p2")] };
    const db = memoryDb(tables);
    await takeSnapshots(db.client);
    expect(tables.project_snapshots).toHaveLength(2);

    writeAuditMock.mockClear();
    const second = await takeSnapshots(db.client);
    expect(second).toEqual({ workspaces: 1, projects: 2, taken: 0, skipped: 2 });
    expect(tables.project_snapshots).toHaveLength(2);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect((writeAuditMock.mock.calls[0][0] as { after: Record<string, unknown> }).after).toMatchObject({ taken: 0, already_taken: 2 });
  });

  it("stores the number set, including the declared and suggested RAG, per project", async () => {
    const tables: Record<string, Row[]> = {
      projects: [project("p1", { rag_status: "green" })],
      project_budget: [{ workspace_id: WS, project_id: "p1", planned_amount: 1000, committed_amount: 0, estimate_to_complete: null, forecast_method: "cpi" }],
      expenses: [{ workspace_id: WS, project_id: "p1", amount: 800 }], // 40% done for 80% spent: CPI 0.5
    };
    await takeSnapshots(memoryDb(tables).client);
    const row = (tables.project_snapshots as Row[])[0];
    expect(row).toMatchObject({ project_id: "p1", taken_at: "2026-10-18", workspace_id: WS, rag_declared: "green", completion_pct: 40 });
    expect(row.cpi).toBe(0.5);
    expect(row.rag_suggested).toBe("amber"); // one low CPI reading is amber, never red on a single snapshot
  });

  it("F7: pages every read, so more than 1000 expense rows are all counted", async () => {
    const cap = (rows: Row[]) => rows;
    const expenses: Row[] = Array.from({ length: 1001 }, (_, i) => ({
      id: `e-${String(i).padStart(5, "0")}`,
      workspace_id: WS,
      project_id: "p1",
      amount: 1,
    }));
    const tables: Record<string, Row[]> = {
      projects: [project("p1")],
      project_budget: [{ workspace_id: WS, project_id: "p1", planned_amount: 1000, committed_amount: 0 }],
      expenses: cap(expenses),
    };
    const db = memoryDb(tables, 1000); // the fake caps one response at 1000 rows, like PostgREST
    await takeSnapshots(db.client);
    const row = tables.project_snapshots[0];
    // 400 earned for 1001 spent: CPI 0.4. A capped read (1000) would give 0.4004 -> 0.4 too, so check EAC.
    expect(row.eac).toBeCloseTo(1000 / (400 / 1001), 1);
  });

  it("reads earlier snapshots so the suggestion reflects the trend", () => {
    const history = [1, 2].map((n) => ({ taken_at: `2026-10-1${n}`, spi: 0.8, cpi: 0.8, slip_days: 0, completion_pct: 40 }));
    const row = buildSnapshot({
      project: project("p1") as never,
      budget: { planned_amount: 1000, committed_amount: 0, estimate_to_complete: null, forecast_method: "cpi" },
      actual: 800,
      openRisksHigh: 0,
      today: "2026-10-18",
      history,
    });
    expect(row.cpi).toBe(0.5);
    expect(row.rag_suggested).toBe("red"); // three low CPI snapshots in a row
  });

  it("does nothing, and writes no audit row, when there are no projects", async () => {
    const out = await takeSnapshots(memoryDb({ projects: [] }).client);
    expect(out).toEqual({ workspaces: 0, projects: 0, taken: 0, skipped: 0 });
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("can be limited to one workspace", async () => {
    const tables: Record<string, Row[]> = { projects: [project("p1"), project("p9", { workspace_id: "ws-2" })] };
    const out = await takeSnapshots(memoryDb(tables).client, { workspaceId: WS });
    expect(out.projects).toBe(1);
    expect(tables.project_snapshots.map((r) => r.project_id)).toEqual(["p1"]);
  });
});

describe("forecastDates", () => {
  it("has no dates without a baseline finish", () => {
    expect(forecastDates({ baseline_start_date: null, baseline_target_date: null, target_date: "2026-12-01" }, 1)).toEqual({
      planned_end: null,
      forecast_end: null,
      slip_days: null,
    });
  });
  it("uses the current finish when it is later than baseline", () => {
    const d = forecastDates({ baseline_start_date: "2026-09-01", baseline_target_date: "2026-12-01", target_date: "2026-12-11" }, 1);
    expect(d).toEqual({ planned_end: "2026-12-01", forecast_end: "2026-12-11", slip_days: 10 });
  });
  it("projects the finish from SPI when work is behind, even if the dates were not moved", () => {
    // 100 day baseline at SPI 0.5 -> 200 days.
    const d = forecastDates({ baseline_start_date: "2026-09-01", baseline_target_date: "2026-12-10", target_date: "2026-12-10" }, 0.5);
    expect(d.slip_days).toBe(100);
  });
  it("never reports a negative slip from a fast SPI alone", () => {
    const d = forecastDates({ baseline_start_date: "2026-09-01", baseline_target_date: "2026-12-10", target_date: "2026-12-10" }, 2);
    expect(d.slip_days).toBe(0);
  });
});

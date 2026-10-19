import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  writeAudit: vi.fn<(i: Record<string, unknown>) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.db }));
vi.mock("@/lib/audit/write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit/write")>()),
  writeAudit: h.writeAudit,
}));

import { runAnchorStep } from "./step";
import { FakeAnchorDb, FakeSink } from "./test-support";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-10-19T01:07:00.000Z");
const FAR = () => Date.now() + 40_000;
const rec = (ws: string, seq: number, hash = `h${seq}`) => ({ workspace_id: ws, chain_seq: seq, head_hash: hash, row_count: seq, anchored_at: "2026-10-18T01:07:00.000Z" });
const actions = () => h.writeAudit.mock.calls.map((c) => `${c[0].action}@${String(c[0].workspaceId).slice(0, 1)}`);

let db: FakeAnchorDb;
let sink: FakeSink;

beforeEach(() => {
  h.writeAudit.mockReset();
  h.writeAudit.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.unstubAllEnvs();
  db = new FakeAnchorDb();
  h.db = db;
  sink = new FakeSink();
});

describe("runAnchorStep (daily cron, R-168 / D11)", () => {
  it("does nothing at all when NOPM_ANCHOR_DB_URL is unset: no query, no audit row, no throw", async () => {
    vi.stubEnv("NOPM_ANCHOR_DB_URL", "");
    db.grow(A, 5);
    const spy = vi.spyOn(db, "from");
    const out = await runAnchorStep(NOW, FAR());
    expect(out).toMatchObject({ configured: false, workspaces: 0, anchored: 0, failed: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it("anchors a new workspace after verifying it, with ONE audit.anchored row, and reads the anchors in ONE call", async () => {
    db.grow(A, 5);
    db.grow(B, 3);
    const out = await runAnchorStep(NOW, FAR(), { sink });
    expect(out).toMatchObject({ configured: true, workspaces: 2, anchored: 2, failed: 0, mismatched: 0 });
    expect(sink.latestCalls).toBe(1);
    expect(db.verifyCalls).toHaveLength(2);
    expect(actions().sort()).toEqual(["audit.anchored@a", "audit.anchored@b"]);
    expect(sink.putCalls.map((p) => [p.workspace_id, p.chain_seq])).toEqual([[A, 5], [B, 3]]);
  });

  it("verifies only the rows since the last anchor (plus the link row) and writes NO audit row for a routine success", async () => {
    db.grow(A, 12);
    sink.seed(rec(A, 9));
    const out = await runAnchorStep(NOW, FAR(), { sink });
    expect(out.anchored).toBe(1);
    expect(db.verifyCalls).toEqual([{ p_workspace_id: A, p_from: null, p_limit: 4 }]); // seq 9..12
    expect(h.writeAudit).not.toHaveBeenCalled();
    expect(sink.putCalls[0]).toMatchObject({ chain_seq: 12, head_hash: "h12" });
  });

  it("adds nothing on a quiet day: an unchanged, already anchored head is skipped without a verify or an audit row", async () => {
    db.grow(A, 7);
    sink.seed(rec(A, 7));
    const out = await runAnchorStep(NOW, FAR(), { sink });
    expect(out).toMatchObject({ skipped: 1, anchored: 0 });
    expect(db.verifyCalls).toHaveLength(0);
    expect(sink.putCalls).toHaveLength(0);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it("never anchors a chain that does not verify: records ONE mismatch row per streak (PR-13)", async () => {
    db.grow(A, 8);
    sink.seed(rec(A, 5));
    db.verify = { ok: false, first_bad_id: "row-7" };
    await runAnchorStep(NOW, FAR(), { sink });
    await runAnchorStep(NOW, FAR(), { sink });
    expect(sink.putCalls).toHaveLength(0);
    expect(actions()).toEqual(["audit.anchor_mismatch@a"]);
    expect(db.receipts.get(A)).toMatchObject({ status: "mismatch" });
  });

  it("never anchors over a live chain that differs from its anchor (rows deleted and regrown)", async () => {
    db.grow(A, 10);
    sink.seed(rec(A, 10));
    db.audit = db.audit.filter((r) => (r.chain_seq as number) <= 4);
    for (let i = 5; i <= 13; i++) db.audit.push({ workspace_id: A, chain_seq: i, row_hash: `regrown${i}` });
    const out = await runAnchorStep(NOW, FAR(), { sink });
    expect(out).toMatchObject({ mismatched: 1, anchored: 0 });
    expect(sink.putCalls).toHaveLength(0);
    expect(db.verifyCalls).toHaveLength(0);
    expect(actions()).toEqual(["audit.anchor_mismatch@a"]);
  });

  it("an unreachable anchor database marks EVERY workspace failed without further attempts (PR-18), one row each", async () => {
    db.grow(A, 3);
    db.grow(B, 3);
    db.grow(C, 3);
    sink.failLatest = "connect ECONNREFUSED [host]";
    const out = await runAnchorStep(NOW, FAR(), { sink });
    expect(out).toMatchObject({ failed: 3, anchored: 0 });
    expect(sink.latestCalls).toBe(1);
    expect(sink.putCalls).toHaveLength(0);
    expect(actions().sort()).toEqual(["audit.anchor_failed@a", "audit.anchor_failed@b", "audit.anchor_failed@c"]);
    await runAnchorStep(NOW, FAR(), { sink });
    expect(h.writeAudit).toHaveBeenCalledTimes(3); // same streak: no new rows
  });

  it("after the FIRST failed put the remaining workspaces are marked failed without trying", async () => {
    db.grow(A, 3);
    db.grow(B, 3);
    db.grow(C, 3);
    for (const ws of [A, B, C]) sink.seed(rec(ws, 1));
    sink.failPut = "timeout";
    const out = await runAnchorStep(NOW, FAR(), { sink });
    expect(out.failed).toBe(3);
    expect(sink.putCalls).toHaveLength(1);
    expect(actions().sort()).toEqual(["audit.anchor_failed@a", "audit.anchor_failed@b", "audit.anchor_failed@c"]);
  });

  it("recovers: the next success clears the streak and writes ONE audit.anchored", async () => {
    db.grow(A, 3);
    sink.seed(rec(A, 1));
    sink.failPut = "timeout";
    await runAnchorStep(NOW, FAR(), { sink });
    h.writeAudit.mockClear();
    sink.failPut = null;
    const out = await runAnchorStep(NOW, FAR(), { sink });
    expect(out.anchored).toBe(1);
    expect(actions()).toEqual(["audit.anchored@a"]);
    expect(db.receipts.get(A)).toMatchObject({ status: "anchored", streak_started_at: null });
  });

  it("stops starting workspaces at the step budget and reports the rest as skipped", async () => {
    db.grow(A, 3);
    db.grow(B, 3);
    const out = await runAnchorStep(NOW, FAR(), { sink, budgetMs: -1 });
    expect(out).toMatchObject({ skippedForDeadline: 2, anchored: 0 });
  });

  it("skips a workspace with an empty audit log", async () => {
    db.workspaces.push(A);
    const out = await runAnchorStep(NOW, FAR(), { sink });
    expect(out).toMatchObject({ workspaces: 1, anchored: 0, failed: 0 });
  });

  it("one workspace's error does not stop the others", async () => {
    db.grow(A, 3);
    db.grow(B, 3);
    sink.seed(rec(A, 1));
    sink.seed(rec(B, 1));
    let first = true;
    const real = db.rpc.bind(db);
    db.rpc = async (name, args) => {
      if (first) { first = false; return { data: null, error: { message: "boom" } }; }
      return real(name, args);
    };
    const out = await runAnchorStep(NOW, FAR(), { sink });
    expect(out).toMatchObject({ failed: 1, anchored: 1 });
  });
});

describe("runAnchorStep: review fixes", () => {
  it("W2-03: an anchored workspace whose audit rows were ALL deleted is a mismatch, not a silent skip", async () => {
    db.workspaces.push(A);
    sink.seed(rec(A, 10));
    const out = await runAnchorStep(NOW, FAR(), { sink });
    expect(out).toMatchObject({ mismatched: 1, anchored: 0 });
    expect(actions()).toEqual(["audit.anchor_mismatch@a"]);
    expect(sink.putCalls).toHaveLength(0);
  });

  it("W2-05: after a failed put, workspaces whose head is already anchored are skipped, not marked failed", async () => {
    db.grow(A, 3);
    db.grow(B, 3);
    db.grow(C, 3);
    sink.seed(rec(A, 1)); // needs a write -> the put fails
    sink.seed(rec(B, 3)); // up to date
    sink.seed(rec(C, 1)); // needs a write -> marked failed without trying
    sink.failPut = "timeout";
    const out = await runAnchorStep(NOW, FAR(), { sink });
    expect(out).toMatchObject({ failed: 2, skipped: 1 });
    expect(sink.putCalls).toHaveLength(1);
    expect(actions().sort()).toEqual(["audit.anchor_failed@a", "audit.anchor_failed@c"]);
    expect(db.receipts.get(B)?.status).not.toBe("failed");
  });

  it("W2-04: a first anchor verifies the WHOLE chain (window = head chain_seq), and a follow-up only the rows since", async () => {
    db.grow(A, 120);
    await runAnchorStep(NOW, FAR(), { sink });
    expect(db.verifyCalls[0]).toEqual({ p_workspace_id: A, p_from: null, p_limit: 120 });
    expect(sink.putCalls).toHaveLength(1);
  });

  it("W2-04: a verified window that does not reach the previous anchor is not anchored on", async () => {
    db.grow(A, 20);
    sink.seed(rec(A, 5));
    const real = db.rpc.bind(db);
    db.rpc = async (name, args) => {
      const r = await real(name, args);
      (r.data as { first_seq: number }[])[0].first_seq = 18; // the check started after the anchor
      return r;
    };
    const out = await runAnchorStep(NOW, FAR(), { sink });
    expect(out.anchored).toBe(0);
    expect(sink.putCalls).toHaveLength(0);
  });
});

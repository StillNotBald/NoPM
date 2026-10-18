import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Actor } from "@/lib/auth/guard";

const h = vi.hoisted(() => ({ writeAudit: vi.fn<(i: Record<string, unknown>) => Promise<void>>(async () => {}) }));
vi.mock("@/lib/audit/write", () => ({ writeAudit: h.writeAudit }));

import { anchorHead, evaluateAnchor, peekAnchor, recordEvaluation } from "./anchor";
import { noopSink } from "./noop-sink";
import { FakeAnchorDb, FakeSink } from "./test-support";

const WS = "11111111-1111-4111-8111-111111111111";
const actor = { type: "user", id: "u1", label: "Ada", workspaceId: WS, role: "admin" } as Actor;
const NOW = new Date("2026-10-19T01:07:00.000Z");

let db: FakeAnchorDb;
let sink: FakeSink;
const ctx = () => ({ db: db.asDb(), sink, workspaceId: WS, actor, now: NOW });
const rec = (seq: number, hash = `h${seq}`) => ({ workspace_id: WS, chain_seq: seq, head_hash: hash, row_count: seq, anchored_at: "2026-10-18T01:07:00.000Z" });
const actions = () => h.writeAudit.mock.calls.map((c) => c[0].action);

beforeEach(() => {
  h.writeAudit.mockReset();
  h.writeAudit.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = new FakeAnchorDb();
  db.grow(WS, 10);
  sink = new FakeSink();
});

describe("evaluateAnchor: the live chain against the newest anchor (R-169)", () => {
  it("is not_anchored without a sink and reads nothing", async () => {
    const ev = await evaluateAnchor({ ...ctx(), sink: noopSink });
    expect(ev.status.state).toBe("not_anchored");
  });

  it("is not_anchored for a workspace that was never anchored", async () => {
    expect((await evaluateAnchor(ctx())).status.state).toBe("not_anchored");
  });

  it("is anchored when the head matches the anchor", async () => {
    sink.seed(rec(10));
    expect((await evaluateAnchor(ctx())).status).toMatchObject({ state: "anchored", chain_seq: 10, row_count: 10 });
  });

  it("is behind (informational) when the chain grew since the anchor", async () => {
    sink.seed(rec(7));
    expect((await evaluateAnchor(ctx())).status).toMatchObject({ state: "behind", rows_behind: 3 });
  });

  it("is mismatch after the newest rows were deleted", async () => {
    sink.seed(rec(10));
    db.audit = db.audit.filter((r) => (r.chain_seq as number) <= 8);
    expect((await evaluateAnchor(ctx())).status.state).toBe("mismatch");
  });

  it("is mismatch after a stored hash was flipped", async () => {
    sink.seed(rec(10));
    db.audit.find((r) => r.chain_seq === 10)!.row_hash = "tampered";
    expect((await evaluateAnchor(ctx())).status.state).toBe("mismatch");
    sink.records.clear();
    sink.seed(rec(6));
    db.audit.find((r) => r.chain_seq === 6)!.row_hash = "tampered";
    expect((await evaluateAnchor(ctx())).status.state).toBe("mismatch"); // older row rewritten, later rows recomputed
  });

  it("is mismatch when the chain was deleted and regrew to the same chain_seq with different hashes", async () => {
    sink.seed(rec(10));
    db.audit = db.audit.filter((r) => (r.chain_seq as number) <= 4);
    for (let i = 5; i <= 12; i++) db.audit.push({ workspace_id: WS, chain_seq: i, row_hash: `regrown${i}` });
    expect((await evaluateAnchor(ctx())).status.state).toBe("mismatch");
  });

  it("is unreachable (never anchored, never an all-clear) when the sink cannot be read", async () => {
    sink.failLatest = "connect ECONNREFUSED [host]";
    const ev = await evaluateAnchor(ctx());
    expect(ev.status).toMatchObject({ state: "unreachable", reason: "connect ECONNREFUSED [host]" });
  });
});

describe("recordEvaluation: one audit row per streak (PR-14)", () => {
  it("writes audit.anchor_mismatch once, however many verifies see the same mismatch", async () => {
    sink.seed(rec(10));
    db.audit.find((r) => r.chain_seq === 10)!.row_hash = "tampered";
    for (let i = 0; i < 3; i++) await recordEvaluation(ctx(), await evaluateAnchor(ctx()));
    expect(actions()).toEqual(["audit.anchor_mismatch"]);
    expect(db.receipts.get(WS)).toMatchObject({ status: "mismatch" });
    expect(h.writeAudit.mock.calls[0][0]).toMatchObject({ workspaceId: WS, actor, targetType: "audit_log" });
  });

  it("fills in since from the streak start", async () => {
    sink.seed(rec(10));
    db.audit.find((r) => r.chain_seq === 10)!.row_hash = "tampered";
    const first = await recordEvaluation(ctx(), await evaluateAnchor(ctx()));
    expect(first.since).toBe(NOW.toISOString());
    const later = await recordEvaluation({ ...ctx(), now: new Date("2026-10-20T00:00:00Z") }, await evaluateAnchor(ctx()));
    expect(later.since).toBe(NOW.toISOString());
  });

  it("writes audit.anchor_failed once per failure streak when the sink cannot be read", async () => {
    sink.failLatest = "connect ECONNREFUSED [host]";
    for (let i = 0; i < 3; i++) await recordEvaluation(ctx(), await evaluateAnchor(ctx()));
    expect(actions()).toEqual(["audit.anchor_failed"]);
    expect(db.receipts.get(WS)).toMatchObject({ status: "failed", error_text: "connect ECONNREFUSED [host]" });
  });

  it("does not remember the streak when the audit row could not be written (so the next run retries it)", async () => {
    sink.failLatest = "down";
    h.writeAudit.mockRejectedValueOnce(new Error("audit down"));
    await recordEvaluation(ctx(), await evaluateAnchor(ctx()));
    expect(db.receipts.has(WS)).toBe(false);
    await recordEvaluation(ctx(), await evaluateAnchor(ctx()));
    expect(actions()).toEqual(["audit.anchor_failed", "audit.anchor_failed"]);
    expect(db.receipts.get(WS)).toMatchObject({ status: "failed" });
  });

  it("keeps the display receipt current on a sound comparison and does not churn it", async () => {
    sink.seed(rec(10));
    await recordEvaluation(ctx(), await evaluateAnchor(ctx()));
    await recordEvaluation(ctx(), await evaluateAnchor(ctx()));
    expect(db.receipts.get(WS)).toMatchObject({ status: "anchored", chain_seq: 10 });
    expect(db.receiptWrites).toBe(1);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });
});

describe("anchorHead (R-168)", () => {
  it("does nothing with no sink: no write, no audit row, no throw", async () => {
    const out = await anchorHead({ ...ctx(), sink: noopSink }, null);
    expect(out.outcome).toBe("disabled");
    expect(h.writeAudit).not.toHaveBeenCalled();
    expect(db.receipts.size).toBe(0);
  });

  it("anchors the first head, then announces it with ONE audit.anchored row (only after the sink confirmed)", async () => {
    const order: string[] = [];
    h.writeAudit.mockImplementation(async (i) => {
      order.push(`audit:${String(i.action)}`);
    });
    const real = sink.put.bind(sink);
    sink.put = async (r) => {
      order.push("put");
      return real(r);
    };
    const out = await anchorHead(ctx(), null);
    expect(out).toMatchObject({ outcome: "anchored", announced: true });
    expect(order).toEqual(["put", "audit:audit.anchored"]);
    expect(sink.putCalls[0]).toMatchObject({ chain_seq: 10, head_hash: "h10", row_count: 10 });
    expect(h.writeAudit.mock.calls[0][0].after).toMatchObject({ reason: "first_anchor", chain_seq: 10, previous_chain_seq: null });
    expect(db.receipts.get(WS)).toMatchObject({ status: "anchored", chain_seq: 10, error_text: null, streak_started_at: null });
  });

  it("a sink that keeps failing never announces anything (no flood of audit.anchored)", async () => {
    sink.failPut = "down";
    for (let i = 0; i < 3; i++) await anchorHead(ctx(), null);
    expect(actions()).toEqual(["audit.anchor_failed"]);
  });

  it("a later success writes NO audit row", async () => {
    sink.seed(rec(7));
    const out = await anchorHead(ctx(), (await sink.latest([WS])).ok ? sink.records.get(WS)![0] : null);
    expect(out.outcome).toBe("anchored");
    expect(h.writeAudit).not.toHaveBeenCalled();
    expect(sink.putCalls[0]).toMatchObject({ chain_seq: 10 });
  });

  it("skips a head that is already anchored", async () => {
    sink.seed(rec(10));
    const out = await anchorHead(ctx(), sink.records.get(WS)![0]);
    expect(out.outcome).toBe("skipped");
    expect(sink.putCalls).toHaveLength(0);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });

  it("a failed put records a streak with ONE audit.anchor_failed and never throws; the next success clears it with ONE audit.anchored", async () => {
    sink.seed(rec(7));
    const latest = sink.records.get(WS)![0];
    sink.failPut = "connect ECONNREFUSED [host]";
    for (let i = 0; i < 3; i++) {
      const out = await anchorHead(ctx(), latest);
      expect(out.outcome).toBe("failed");
      expect(out.status.state).toBe("unreachable");
    }
    expect(actions()).toEqual(["audit.anchor_failed"]);
    expect(db.receipts.get(WS)).toMatchObject({ status: "failed", streak_started_at: NOW.toISOString() });

    sink.failPut = null;
    h.writeAudit.mockClear();
    const ok = await anchorHead(ctx(), latest);
    expect(ok).toMatchObject({ outcome: "anchored", announced: true });
    expect(actions()).toEqual(["audit.anchored"]);
    expect(db.receipts.get(WS)).toMatchObject({ status: "anchored", streak_started_at: null, error_text: null });
  });

  it("a unique conflict with a different hash is a mismatch, not a failed insert (PR-14)", async () => {
    sink.seed(rec(10, "someone-else"));
    const out = await anchorHead(ctx(), rec(7));
    expect(out.outcome).toBe("mismatch");
    expect(out.status.state).toBe("mismatch");
    expect(actions()).toEqual(["audit.anchor_mismatch"]);
    expect(db.receipts.get(WS)).toMatchObject({ status: "mismatch" });
    // and a second attempt in the same streak writes no second row
    await anchorHead(ctx(), rec(7));
    expect(actions()).toEqual(["audit.anchor_mismatch"]);
  });

  it("an empty audit log has nothing to anchor", async () => {
    db.audit = [];
    expect((await anchorHead(ctx(), null)).outcome).toBe("empty");
    expect(sink.putCalls).toHaveLength(0);
  });

  it("still anchors when the announcement row cannot be written (fail-open)", async () => {
    h.writeAudit.mockRejectedValueOnce(new Error("audit down"));
    const out = await anchorHead(ctx(), null);
    expect(out).toMatchObject({ outcome: "anchored", announced: false });
  });
});

describe("peekAnchor (audit pack)", () => {
  it("reads without recording anything and never throws", async () => {
    sink.seed(rec(10));
    expect((await peekAnchor(db.asDb(), sink, WS)).state).toBe("anchored");
    sink.failLatest = "down";
    expect((await peekAnchor(db.asDb(), sink, WS)).state).toBe("unreachable");
    expect((await peekAnchor(db.asDb(), noopSink, WS)).state).toBe("not_anchored");
    expect(h.writeAudit).not.toHaveBeenCalled();
    expect(db.receiptWrites).toBe(0);
  });
});

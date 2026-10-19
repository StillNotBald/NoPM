import { describe, it, expect, vi } from "vitest";
import { anchorLine, chainHeadLine, getChainHead } from "./chain-head";
import { gatherAuditPack } from "@/lib/export/audit-pack";
import { FakeSink } from "./anchor/test-support";

const sinkState = vi.hoisted(() => ({ sink: null as unknown }));
vi.mock("@/lib/audit/anchor/get-sink", () => ({
  getAnchorSink: () => sinkState.sink ?? { kind: "none", put: async () => ({ status: "disabled" }), latest: async () => ({ ok: true, records: new Map() }) },
}));
import { FakeDb, WS } from "@/lib/integrations/test-support";
import { renderAuditPackPdf } from "@/lib/reports/pdf";
import { renderWeeklyReportHtml, type WeeklySnapshot } from "@/lib/reports/weekly-html";
import type { AuditPackData } from "@/lib/export/audit-pack";

/**
 * R-154: the newest audit row hash leaves the database on the weekly report and the audit pack
 * cover, so deleting the newest rows is detectable against the last printed head.
 */
const HASH = "a52366a6749d89a8a71cfc929f347933d840e6b80f868f0fa28f88f71e13294c";

describe("getChainHead", () => {
  it("returns the hash of the highest chain_seq of THIS workspace", async () => {
    const db = new FakeDb();
    db.seed("audit_log", [
      { workspace_id: WS, chain_seq: 1, row_hash: "old", created_at: "2026-10-01T00:00:00.000Z" },
      { workspace_id: WS, chain_seq: 2, row_hash: HASH, created_at: "2026-10-18T01:02:03.000Z" },
      { workspace_id: "other", chain_seq: 9, row_hash: "foreign", created_at: "2026-10-19T00:00:00.000Z" },
    ]);
    expect(await getChainHead(db, WS)).toEqual({ hash: HASH, at: "2026-10-18T01:02:03.000Z" });
  });

  it("is null for an empty log, a schema without row_hash, or a failing read", async () => {
    expect(await getChainHead(new FakeDb(), WS)).toBeNull();
    const db = new FakeDb();
    db.seed("audit_log", [{ workspace_id: WS, chain_seq: 1, created_at: "2026-10-01T00:00:00.000Z" }]);
    expect(await getChainHead(db, WS)).toBeNull();
    expect(await getChainHead({ from: () => { throw new Error("down"); } }, WS)).toBeNull();
  });
});

describe("chainHeadLine", () => {
  it("reads 'Audit chain head: <hash> at <time> UTC'", () => {
    expect(chainHeadLine({ hash: HASH, at: "2026-10-18T01:02:03.456Z" })).toBe(`Audit chain head: ${HASH} at 2026-10-18 01:02:03 UTC`);
    expect(chainHeadLine(null)).toBeNull();
  });
});

describe("where the head is printed", () => {
  const snap = (chainHead?: { hash: string; at: string } | null): WeeklySnapshot => ({
    weekStart: "2026-10-12",
    staleDays: 14,
    stale: [],
    chainHead,
    digest: {
      workspaceName: "Acme", generatedAt: "2026-10-18T00:00:00.000Z", projects: [], milestonesDueSoon: [],
      openHighRisks: 0, pendingApprovals: 0,
    } as unknown as WeeklySnapshot["digest"],
  });

  it("the weekly report HTML carries the line, and omits it for an older snapshot", () => {
    expect(renderWeeklyReportHtml(snap({ hash: HASH, at: "2026-10-18T01:02:03.000Z" }))).toContain(`Audit chain head: ${HASH} at 2026-10-18 01:02:03 UTC`);
    expect(renderWeeklyReportHtml(snap())).not.toContain("Audit chain head");
  });

  const pack: AuditPackData = {
    workspaceName: "Acme", generatedAt: "2026-10-18T10:00:00.000Z", generatedBy: "Auditor",
    changeRequests: [], evidence: [], decisions: [], audit: [], truncated: false,
    unavailable: { evidence: false, decisionLinks: false },
    totals: { change_requests: 0, evidence: 0, decisions: 0, approvals_audit: 0 },
  };

  it("the audit pack PDF cover carries the line, and omits it without a head", () => {
    const withHead = renderAuditPackPdf({ ...pack, chainHead: { hash: HASH, at: "2026-10-18T01:02:03.000Z" } }).toString("latin1");
    expect(withHead).toContain(`Audit chain head: ${HASH} at 2026-10-18 01:02:03 UTC`);
    expect(renderAuditPackPdf(pack).toString("latin1")).not.toContain("Audit chain head");
  });
});

describe("the audit pack carries the anchor state (R-169f)", () => {
  const seedChain = (db: FakeDb) => {
    db.seed("workspaces", [{ id: WS, name: "Acme" }]);
    db.seed("audit_log", [
      { workspace_id: WS, chain_seq: 1, row_hash: "h1", created_at: "2026-10-01T00:00:00.000Z" },
      { workspace_id: WS, chain_seq: 2, row_hash: "h2", created_at: "2026-10-02T00:00:00.000Z" },
    ]);
  };
  const anchored = (chain_seq: number, head_hash: string) => ({ workspace_id: WS, chain_seq, head_hash, row_count: chain_seq, anchored_at: "2026-10-18T20:09:00.000Z" });

  it("reads 'Anchor: not anchored' when the variable is unset, without reading anything", async () => {
    sinkState.sink = null;
    const db = new FakeDb();
    seedChain(db);
    const pack = await gatherAuditPack(db as never, WS, { on: "created" }, "Auditor");
    expect(pack.anchor?.state).toBe("not_anchored");
    expect(anchorLine(pack.anchor)).toBe("Anchor: not anchored");
  });

  it("reads the anchored time and rows when the live head matches", async () => {
    const sink = new FakeSink();
    sink.seed(anchored(2, "h2"));
    sinkState.sink = sink;
    const db = new FakeDb();
    seedChain(db);
    const pack = await gatherAuditPack(db as never, WS, { on: "created" }, "Auditor");
    expect(anchorLine(pack.anchor)).toBe("Anchor: anchored 2026-10-18 20:09 UTC (2 rows)");
  });

  it("never hides a mismatch or an unreachable anchor database", async () => {
    const sink = new FakeSink();
    sink.seed(anchored(2, "someone-else"));
    sinkState.sink = sink;
    const db = new FakeDb();
    seedChain(db);
    expect(anchorLine((await gatherAuditPack(db as never, WS, { on: "created" }, "Auditor")).anchor)).toContain("MISMATCH");
    const down = new FakeSink();
    down.failLatest = "down";
    sinkState.sink = down;
    expect(anchorLine((await gatherAuditPack(db as never, WS, { on: "created" }, "Auditor")).anchor)).toContain("unreachable");
    sinkState.sink = null;
  });
});

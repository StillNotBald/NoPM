import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { runApprovalRequestedMock, writeAuditMock } = vi.hoisted(() => ({
  runApprovalRequestedMock: vi.fn(async (_ev: Record<string, unknown>, _opts?: unknown) => {}),
  writeAuditMock: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/audit/write", () => ({ writeAudit: writeAuditMock }));
vi.mock("@/lib/integrations/emit", () => ({ runApprovalRequested: runApprovalRequestedMock }));
vi.mock("@/lib/governance/decide", () => ({
  projectNameOf: async () => "Proj",
  changeRequestEvent: async (_db: unknown, workspaceId: string, cr: { id: string; updated_at: string }) => ({
    workspaceId,
    kind: "change_request",
    id: cr.id,
    title: "CR",
    requestedByLabel: "x",
    requesterPrincipalId: null,
    version: cr.updated_at,
  }),
}));

import { RECONCILE_MAX_AGE_MS, RECONCILE_MIN_AGE_MS, reconcileLostApprovals, requeueDeadApprovals } from "./catchup";
import { CONNECTOR_ID, FakeDb, OTHER_WS, TEST_ENCRYPTION_KEY, WS, connectorRow, ids } from "./test-support";

// F1 (reconciliation of a lost emit) and F2 (requeue dead) of the 2026-10-17 integration review.

const NOW = new Date("2026-10-18T12:00:00.000Z");
const WIDE = 365 * 24 * 3_600_000; // the seeded requests are weeks old; the look-back has its own tests
const agoIso = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

let db: FakeDb;
beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
  runApprovalRequestedMock.mockReset();
  runApprovalRequestedMock.mockResolvedValue(undefined);
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  db = new FakeDb();
  state.db = db;
  db.seed("deletion_requests", [
    { id: "del-task", workspace_id: WS, status: "pending", target_type: "task", target_id: "t1", reason: null, before: { name: "T", project_id: "p1" }, requested_by_label: "Max", requested_principal_id: "u-max", created_at: "2026-10-01T00:00:00Z" },
    { id: "del-proj", workspace_id: WS, status: "pending", target_type: "project", target_id: "p9", reason: null, before: { name: "P" }, requested_by_label: "Max", requested_principal_id: "u-max", created_at: "2026-10-02T00:00:00Z" },
    { id: "del-other", workspace_id: OTHER_WS, status: "pending", target_type: "task", target_id: "t3", before: { name: "X" }, created_at: "2026-10-04T00:00:00Z" },
  ]);
  db.seed("change_requests", [
    { id: "cr-1", workspace_id: WS, status: "raised", updated_at: "v1", created_at: "2026-10-01T00:00:00Z" },
    { id: "cr-2", workspace_id: WS, status: "under_review", updated_at: "v2", created_at: "2026-10-02T00:00:00Z" },
    { id: "cr-done", workspace_id: WS, status: "approved", updated_at: "v3", created_at: "2026-10-03T00:00:00Z" },
  ]);
});
afterEach(() => vi.unstubAllEnvs());

const emitted = () => runApprovalRequestedMock.mock.calls.map((c) => c[0] as unknown as { kind: string; id: string; version?: string });
const audits = () => writeAuditMock.mock.calls.map((c) => c[0] as Record<string, any>); // eslint-disable-line @typescript-eslint/no-explicit-any

const cardRow = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id,
  workspace_id: WS,
  connector_id: CONNECTOR_ID,
  kind: "approval_card",
  approval_kind: "change_request",
  approval_id: "cr-1",
  recipient_profile_id: ids.manager,
  status,
  created_at: agoIso(3_600_000),
  ...over,
});

describe("reconcileLostApprovals (F1)", () => {
  it("sends only requests older than the grace period that have no card at all, in this workspace", async () => {
    db.seed("change_requests", [{ id: "cr-young", workspace_id: WS, status: "raised", updated_at: "v9", created_at: agoIso(60_000) }]);

    const res = await reconcileLostApprovals(connectorRow(), { now: NOW, maxAgeMs: WIDE });

    expect(res).toEqual({ considered: 4, queued: 4 });
    expect(emitted().map((e) => e.id).sort()).toEqual(["cr-1", "cr-2", "del-proj", "del-task"]);
  });

  it("skips a request that already has a card in any live state, or a dead one", async () => {
    db.seed("integration_deliveries", [
      cardRow("d1", "sent", { approval_id: "cr-1" }),
      cardRow("d2", "dead", { approval_id: "cr-2" }),
      cardRow("d3", "retry", { approval_kind: "task_deletion", approval_id: "del-task" }),
      cardRow("d4", "pending", { approval_kind: "project_deletion", approval_id: "del-proj" }),
    ]);
    expect(await reconcileLostApprovals(connectorRow(), { now: NOW, maxAgeMs: WIDE })).toEqual({ considered: 0, queued: 0 });
    expect(runApprovalRequestedMock).not.toHaveBeenCalled();
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("a card that was only superseded does not count as delivered", async () => {
    db.seed("integration_deliveries", [cardRow("d1", "superseded", { approval_id: "cr-1" })]);
    await reconcileLostApprovals(connectorRow(), { now: NOW, maxAgeMs: WIDE });
    expect(emitted().map((e) => e.id)).toContain("cr-1");
  });

  it("audits as the connector (the scheduler actor) BEFORE it queues a card, naming the requests", async () => {
    const order: string[] = [];
    writeAuditMock.mockImplementation(async () => void order.push("audit"));
    runApprovalRequestedMock.mockImplementation(async () => void order.push("card"));

    await reconcileLostApprovals(connectorRow(), { now: NOW, maxAgeMs: WIDE });

    expect(order[0]).toBe("audit");
    expect(order.filter((o) => o === "audit")).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ action: "integration.approvals.reconcile", targetId: CONNECTOR_ID, workspaceId: WS });
    expect(audits()[0].actor).toMatchObject({ type: "token", id: CONNECTOR_ID, viaConnectorId: CONNECTOR_ID, principalId: null, channel: "lark" });
    expect(audits()[0].after.requests).toHaveLength(4);
  });

  it("does nothing, and writes no audit row, when every request is still inside the grace period", async () => {
    const res = await reconcileLostApprovals(connectorRow(), { now: new Date("2026-09-30T00:00:00Z") });
    expect(res).toEqual({ considered: 0, queued: 0 });
    expect(writeAuditMock).not.toHaveBeenCalled();
    expect(runApprovalRequestedMock).not.toHaveBeenCalled();
  });

  it("does nothing for a paused connector or one with approvals off", async () => {
    expect(await reconcileLostApprovals(connectorRow({ status: "paused" }), { now: NOW, maxAgeMs: WIDE })).toEqual({ considered: 0, queued: 0 });
    const off = connectorRow();
    off.config = { ...off.config, approvals: { enabled: false } };
    expect(await reconcileLostApprovals(off, { now: NOW, maxAgeMs: WIDE })).toEqual({ considered: 0, queued: 0 });
    expect(runApprovalRequestedMock).not.toHaveBeenCalled();
  });

  it("respects the limit, and one failing request does not cost the others their card", async () => {
    runApprovalRequestedMock.mockRejectedValueOnce(new Error("boom"));
    const res = await reconcileLostApprovals(connectorRow(), { now: NOW, maxAgeMs: WIDE, limit: 3 });
    expect(res).toEqual({ considered: 3, queued: 2 });
    expect(runApprovalRequestedMock).toHaveBeenCalledTimes(3);
  });

  it("a lookup failure surfaces to the caller instead of guessing", async () => {
    db.failNext({ table: "integration_deliveries", op: "select", error: { message: "down" } });
    await expect(reconcileLostApprovals(connectorRow(), { now: NOW, maxAgeMs: WIDE })).rejects.toBeTruthy();
    expect(runApprovalRequestedMock).not.toHaveBeenCalled();
  });

  it("a lost request is found even when the oldest pending requests all hold cards (no starvation)", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `cr-old-${i}`, workspace_id: WS, status: "raised", updated_at: "v", created_at: agoIso(2 * 24 * 3_600_000 - i * 1000) }));
    db.seed("change_requests", [...many, { id: "cr-lost-new", workspace_id: WS, status: "raised", updated_at: "v", created_at: agoIso(3_600_000) }]);
    db.seed("integration_deliveries", many.map((c, i) => cardRow(`c${i}`, "sent", { approval_id: c.id })));
    const res = await reconcileLostApprovals(connectorRow(), { now: NOW, limit: 20, scan: 100 });
    expect(emitted().map((e) => e.id)).toContain("cr-lost-new");
    expect(res.queued).toBeGreaterThan(0);
  });

  it("only repairs requests raised inside the look-back window, so an unreachable request is not re-audited forever", async () => {
    const res = await reconcileLostApprovals(connectorRow(), { now: NOW });
    expect(res).toEqual({ considered: 0, queued: 0 });
    expect(writeAuditMock).not.toHaveBeenCalled();
    expect(RECONCILE_MAX_AGE_MS).toBe(3 * 24 * 3_600_000);
  });

  it("the grace period is five minutes", () => {
    expect(RECONCILE_MIN_AGE_MS).toBe(5 * 60_000);
  });
});

describe("requeueDeadApprovals (F2)", () => {
  it("re-sends cards for requests that are still pending and have a dead card, reporting the plan first", async () => {
    db.seed("integration_deliveries", [
      cardRow("dead-1", "dead", { approval_id: "cr-1" }),
      cardRow("dead-2", "dead", { approval_id: "cr-1", recipient_profile_id: ids.manager2 }),
      cardRow("dead-3", "dead", { approval_kind: "task_deletion", approval_id: "del-task" }),
      cardRow("dead-gone", "dead", { approval_id: "cr-done" }),
      cardRow("live-other", "sent", { approval_id: "cr-2" }),
    ]);
    const seen: unknown[] = [];

    const res = await requeueDeadApprovals(connectorRow(), async (plan) => void seen.push(plan));

    expect(res).toEqual({ dead_requests: 3, still_pending: 2 });
    expect(seen).toEqual([res]);
    expect(emitted().map((e) => `${e.kind}:${e.id}`).sort()).toEqual(["change_request:cr-1", "task_deletion:del-task"]);
  });

  it("also re-sends for a card that was sent but never clicked and is older than the 7-day button lifetime", async () => {
    db.seed("integration_deliveries", [
      cardRow("old-sent", "sent", { approval_id: "cr-1", created_at: agoIso(8 * 24 * 3_600_000) }),
      cardRow("fresh-sent", "sent", { approval_id: "cr-2", created_at: agoIso(2 * 24 * 3_600_000) }),
    ]);
    const res = await requeueDeadApprovals(connectorRow(), async () => {});
    expect(res).toEqual({ dead_requests: 1, still_pending: 1 });
    expect(emitted().map((e) => e.id)).toEqual(["cr-1"]);
  });

  it("hands the plan to the audit callback BEFORE any card is queued", async () => {
    db.seed("integration_deliveries", [cardRow("dead-1", "dead")]);
    const order: string[] = [];
    runApprovalRequestedMock.mockImplementation(async () => void order.push("card"));
    await requeueDeadApprovals(connectorRow(), async () => void order.push("audit"));
    expect(order).toEqual(["audit", "card"]);
  });

  it("rebuilds the event from the request as it is NOW (an edited request carries its current version)", async () => {
    db.seed("integration_deliveries", [cardRow("dead-1", "dead", { approval_id: "cr-2" })]);
    db.rows("change_requests").find((r) => r.id === "cr-2")!.updated_at = "v2-edited";
    await requeueDeadApprovals(connectorRow(), async () => {});
    expect(emitted()[0]).toMatchObject({ id: "cr-2", version: "v2-edited" });
  });

  it("goes through the normal fan-out, which owns dedupe, the card budget and the approver rules", async () => {
    db.seed("integration_deliveries", [cardRow("dead-1", "dead")]);
    await requeueDeadApprovals(connectorRow(), async () => {});
    expect(runApprovalRequestedMock).toHaveBeenCalledTimes(1);
    expect(runApprovalRequestedMock.mock.calls[0]).toHaveLength(1); // no "replacement" option
  });

  it("only looks at approval cards of this connector and workspace (not digests, not other tenants)", async () => {
    db.seed("integration_deliveries", [
      cardRow("digest-dead", "dead", { kind: "digest", approval_kind: null, approval_id: null }),
      cardRow("other-ws", "dead", { workspace_id: OTHER_WS }),
      cardRow("other-connector", "dead", { connector_id: "second-connector" }),
    ]);
    expect(await requeueDeadApprovals(connectorRow(), async () => {})).toEqual({ dead_requests: 0, still_pending: 0 });
    expect(runApprovalRequestedMock).not.toHaveBeenCalled();
  });

  it("with nothing dead it reports honestly and queues nothing", async () => {
    const seen: unknown[] = [];
    expect(await requeueDeadApprovals(connectorRow(), async (p) => void seen.push(p))).toEqual({ dead_requests: 0, still_pending: 0 });
    expect(seen).toHaveLength(1);
  });
});

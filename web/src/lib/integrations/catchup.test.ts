import { describe, it, expect, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { runApprovalRequestedMock } = vi.hoisted(() => ({ runApprovalRequestedMock: vi.fn(async (_ev: Record<string, unknown>, _opts?: unknown) => {}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
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

import { catchUpPendingApprovals, CATCH_UP_LIMIT_PER_KIND, CATCH_UP_TOTAL_CAP } from "./catchup";
import { FakeDb, OTHER_WS, WS } from "./test-support";

let db: FakeDb;
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  runApprovalRequestedMock.mockReset();
  runApprovalRequestedMock.mockResolvedValue(undefined);
  db = new FakeDb();
  state.db = db;
  db.seed("deletion_requests", [
    {
      id: "del-task",
      workspace_id: WS,
      status: "pending",
      target_type: "task",
      target_id: "t1",
      reason: "obsolete",
      before: { name: "Old task", project_id: "p1" },
      requested_by_label: "Max",
      requested_principal_id: "u-max",
      created_at: "2026-10-01T00:00:00Z",
    },
    {
      id: "del-proj",
      workspace_id: WS,
      status: "pending",
      target_type: "project",
      target_id: "p9",
      reason: null,
      before: { name: "Old project" },
      requested_by_label: "Max",
      requested_principal_id: "u-max",
      created_at: "2026-10-02T00:00:00Z",
    },
    { id: "del-done", workspace_id: WS, status: "committed", target_type: "task", target_id: "t2", before: {}, created_at: "2026-10-03T00:00:00Z" },
    { id: "del-other", workspace_id: OTHER_WS, status: "pending", target_type: "task", target_id: "t3", before: { name: "X" }, created_at: "2026-10-04T00:00:00Z" },
  ]);
  db.seed("change_requests", [
    { id: "cr-1", workspace_id: WS, status: "raised", updated_at: "v1", created_at: "2026-10-01T00:00:00Z" },
    { id: "cr-2", workspace_id: WS, status: "under_review", updated_at: "v2", created_at: "2026-10-02T00:00:00Z" },
    { id: "cr-done", workspace_id: WS, status: "approved", updated_at: "v3", created_at: "2026-10-03T00:00:00Z" },
  ]);
});

const emitted = () => runApprovalRequestedMock.mock.calls.map((c) => c[0] as unknown as { kind: string; id: string; title: string; version?: string });

describe("catchUpPendingApprovals (D-ACC-7)", () => {
  it("queues a card event for every request still pending, in this workspace only", async () => {
    const res = await catchUpPendingApprovals(WS);

    expect(res.considered).toBe(4);
    const ids = emitted().map((e) => `${e.kind}:${e.id}`).sort();
    expect(ids).toEqual([
      "change_request:cr-1",
      "change_request:cr-2",
      "project_deletion:del-proj",
      "task_deletion:del-task",
    ]);
  });

  it("builds deletion events from the request snapshot, with the requester principal (so four-eyes excludes them)", async () => {
    await catchUpPendingApprovals(WS);
    const task = runApprovalRequestedMock.mock.calls.map((c) => c[0] as unknown as Record<string, unknown>).find((e) => e.id === "del-task")!;
    expect(task).toMatchObject({
      workspaceId: WS,
      title: 'Delete task "Old task"',
      summary: "obsolete",
      projectId: "p1",
      projectName: "Proj",
      requesterPrincipalId: "u-max",
    });
    const proj = runApprovalRequestedMock.mock.calls.map((c) => c[0] as unknown as Record<string, unknown>).find((e) => e.id === "del-proj")!;
    expect(proj).toMatchObject({ title: 'Delete project "Old project"', projectId: "p9", projectName: "Old project" });
  });

  it("stamps versioned kinds with the version of the row it read (the card binds to what it shows)", async () => {
    await catchUpPendingApprovals(WS);
    expect(emitted().find((e) => e.id === "cr-2")!.version).toBe("v2");
    expect(emitted().find((e) => e.id === "cr-1")!.version).toBe("v1");
  });

  it("goes through runApprovalRequested, which owns dedupe, the card budget and the approver rules", async () => {
    await catchUpPendingApprovals(WS);
    expect(runApprovalRequestedMock).toHaveBeenCalledTimes(4);
    // never called with a "replacement" option: a catch-up card counts against the hourly budget
    for (const call of runApprovalRequestedMock.mock.calls) expect(call).toHaveLength(1);
  });

  it("one request failing does not cost the others their card", async () => {
    runApprovalRequestedMock.mockRejectedValueOnce(new Error("boom"));
    await catchUpPendingApprovals(WS);
    expect(runApprovalRequestedMock).toHaveBeenCalledTimes(4);
  });

  it("one table failing to read does not stop the other kinds", async () => {
    db.failNext({ table: "change_requests", op: "select", error: { message: "down" } });
    const res = await catchUpPendingApprovals(WS);
    expect(res.considered).toBe(2);
    expect(emitted().map((e) => e.kind).sort()).toEqual(["project_deletion", "task_deletion"]);
  });

  it("does nothing when nothing is pending", async () => {
    state.db = new FakeDb();
    expect((await catchUpPendingApprovals(WS)).considered).toBe(0);
    expect(runApprovalRequestedMock).not.toHaveBeenCalled();
  });

  it("is bounded per kind and in total", async () => {
    expect(CATCH_UP_LIMIT_PER_KIND).toBeLessThanOrEqual(25);
    const many = Array.from({ length: 80 }, (_, i) => ({
      id: "m" + i, workspace_id: WS, status: "submitted", updated_at: "v", created_at: "2026-10-06T00:00:" + String(i % 60).padStart(2, "0") + "Z",
    }));
    db.seed("change_requests", many.map((r) => ({ ...r, id: "c" + r.id, status: "raised" })));
    const res = await catchUpPendingApprovals(WS);
    expect(res.considered).toBeLessThanOrEqual(CATCH_UP_TOTAL_CAP);
    expect(runApprovalRequestedMock.mock.calls.length).toBeLessThanOrEqual(CATCH_UP_TOTAL_CAP);
  });
});

describe("catchUpPendingApprovals - rebaseline sign-offs (Q-ACC-13, Q-GOV-19)", () => {
  it("also queues a card for a rebaseline still waiting for sign-off, never for a decided one or another workspace's", async () => {
    db.seed("rebaselines", [
      { id: "rb-1", workspace_id: WS, project_id: "p1", version: 2, status: "pending_approval", reason: "Slip", requested_by: "u-max", requested_principal_id: "u-max", after: null, created_at: "2026-10-05T00:00:00Z" },
      { id: "rb-done", workspace_id: WS, project_id: "p1", version: 1, status: "applied", created_at: "2026-10-01T00:00:00Z" },
      { id: "rb-other", workspace_id: OTHER_WS, project_id: "px", version: 1, status: "pending_approval", created_at: "2026-10-02T00:00:00Z" },
    ]);
    const res = await catchUpPendingApprovals(WS);
    expect(res.considered).toBe(5);
    const rb = emitted().filter((e) => e.kind === "rebaseline_signoff");
    expect(rb.map((e) => e.id)).toEqual(["rb-1"]);
    expect(rb[0].title).toBe("Rebaseline v2: Proj");
  });
});

describe("catchUpPendingApprovals: deletion of risks, issues, expenses, documents and milestones (G8)", () => {
  it("queues a card per new kind with the record's own title, and skips a type it does not know", async () => {
    state.db = db = new FakeDb();
    const row = (id: string, target_type: string, before: Record<string, unknown>) => ({
      id,
      workspace_id: WS,
      status: "pending",
      target_type,
      target_id: `${target_type}-1`,
      reason: "tidy up",
      before,
      requested_by_label: "Max",
      requested_principal_id: "u-max",
      created_at: "2026-10-05T00:00:00Z",
    });
    db.seed("deletion_requests", [
      row("d-risk", "risk", { title: "Vendor slips", project_id: "p1" }),
      row("d-issue", "issue", { title: "Login fails", project_id: "p1" }),
      row("d-exp", "expense", { description: "Hotel", project_id: "p1" }),
      row("d-doc", "document", { title: "Charter", project_id: "p1" }),
      row("d-ms", "milestone", { name: "Go-live", project_id: "p1" }),
      row("d-odd", "clash", { title: "Odd", project_id: "p1" }),
    ]);
    await catchUpPendingApprovals(WS);
    const byId = Object.fromEntries(emitted().map((e) => [e.id, e]));
    expect(byId["d-risk"]).toMatchObject({ kind: "risk_deletion", title: 'Delete risk "Vendor slips"' });
    expect(byId["d-issue"]).toMatchObject({ kind: "issue_deletion", title: 'Delete issue "Login fails"' });
    expect(byId["d-exp"]).toMatchObject({ kind: "expense_deletion", title: 'Delete expense "Hotel"' });
    expect(byId["d-doc"]).toMatchObject({ kind: "document_deletion", title: 'Delete document "Charter"' });
    expect(byId["d-ms"]).toMatchObject({ kind: "milestone_deletion", title: 'Delete milestone "Go-live"' });
    expect(byId["d-odd"]).toBeUndefined();
  });
});

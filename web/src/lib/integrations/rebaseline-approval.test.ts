import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { announceDecidedMock } = vi.hoisted(() => ({ announceDecidedMock: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/integrations/emit", () => ({
  emitApprovalChanged: vi.fn(),
  emitApprovalDecided: announceDecidedMock,
  emitApprovalRequested: vi.fn(),
}));

import type { Actor } from "@/lib/auth/guard";
import { rebaselineEvent, signoffRebaseline } from "./rebaseline-approval";
import { FakeDb, TEST_ENCRYPTION_KEY, WS, ids, seedWorkspace } from "./test-support";

const RB = "c0000000-0000-4000-8000-000000000001";
const PROJECT = "d0000000-0000-4000-8000-000000000001";

let db: FakeDb;
let rpcCalls: Record<string, unknown>[];

const lark = (over: Partial<Actor> = {}): Actor => ({
  type: "user",
  id: ids.manager,
  principalId: ids.manager,
  label: "Max Manager",
  workspaceId: WS,
  role: "manager",
  channel: "lark",
  ...over,
});

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  announceDecidedMock.mockReset();
  db = new FakeDb();
  state.db = db;
  seedWorkspace(db);
  db.seed("projects", [{ id: PROJECT, workspace_id: WS, name: "Apollo" }]);
  db.seed("rebaselines", [
    {
      id: RB,
      workspace_id: WS,
      project_id: PROJECT,
      version: 2,
      status: "pending_approval",
      reason: "Vendor slipped",
      requested_by: ids.requester,
      requested_principal_id: ids.requester,
      after: { start_date: "2026-11-01", end_date: "2026-12-15" },
    },
  ]);
  rpcCalls = [];
  db.rpc = (async (name?: string, args: Record<string, unknown> = {}) => {
    rpcCalls.push({ name, ...args });
    return { data: { signoff: {}, rebaseline: { id: RB, status: args.p_vote === "go" ? "approved" : "rejected" } }, error: null, count: null };
  }) as typeof db.rpc;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("rebaselineEvent", () => {
  it("a no_go without a reason is refused 422 rationale_required before anything is written", async () => {
    await expect(signoffRebaseline(lark(), RB, "no_go", "  ")).rejects.toMatchObject({
      code: "rationale_required",
      message: "Please give a reason for rejecting.",
    });
  });

  it("describes the proposal: project, version, reason and the exact new dates", async () => {
    const ev = await rebaselineEvent(db as never, WS, db.rows("rebaselines")[0] as never);
    expect(ev).toMatchObject({
      kind: "rebaseline_signoff",
      id: RB,
      title: "Rebaseline v2: Apollo",
      projectName: "Apollo",
      requestedByLabel: "Rae Requester",
      requesterPrincipalId: ids.requester,
    });
    expect(ev.summary).toContain("Vendor slipped");
    expect(ev.summary).toContain("New dates: 2026-11-01 to 2026-12-15");
  });
});

describe("signoffRebaseline (Lark Approve = go, Reject = no_go)", () => {
  it("votes go through the atomic RPC with lark provenance and announces the decision", async () => {
    const res = await signoffRebaseline(lark({ viaConnectorId: "conn-1", externalEventId: "evt-1" }), RB, "go");
    expect(res).toMatchObject({ kind: "rebaseline_signoff", id: RB, status: "approved" });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toMatchObject({
      name: "nopm_signoff_rebaseline",
      p_rebaseline_id: RB,
      p_workspace_id: WS,
      p_vote: "go",
      p_approver_principal_id: ids.manager,
      p_channel: "lark",
      p_via_connector_id: "conn-1",
      p_external_event_id: "evt-1",
    });
    expect(announceDecidedMock).toHaveBeenCalledTimes(1);
  });

  it("reject sends no_go with the reason as the comment", async () => {
    const res = await signoffRebaseline(lark(), RB, "no_go", "Dates too tight");
    expect(res.status).toBe("rejected");
    expect(rpcCalls[0]).toMatchObject({ p_vote: "no_go", p_comment: "Dates too tight" });
  });

  it("refuses the person who proposed it (four-eyes) before the RPC", async () => {
    await expect(signoffRebaseline(lark({ id: ids.requester, principalId: ids.requester }), RB, "go")).rejects.toMatchObject({
      code: "self_approval",
    });
    expect(rpcCalls).toHaveLength(0);
    expect(announceDecidedMock).not.toHaveBeenCalled();
  });

  it("refuses a member (approvers are admins and managers only)", async () => {
    await expect(signoffRebaseline(lark({ role: "member" }), RB, "go")).rejects.toMatchObject({ code: "role_not_permitted" });
    expect(rpcCalls).toHaveLength(0);
  });

  it("refuses a rebaseline that is no longer waiting for sign-off", async () => {
    db.rows("rebaselines")[0].status = "approved";
    await expect(signoffRebaseline(lark(), RB, "go")).rejects.toBeTruthy();
    expect(rpcCalls).toHaveLength(0);
  });

  it("404s a rebaseline from another workspace", async () => {
    await expect(signoffRebaseline(lark({ workspaceId: "other-ws" }), RB, "go")).rejects.toMatchObject({ status: 404 });
  });
});

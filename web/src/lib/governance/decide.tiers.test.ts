/**
 * Approval tiers at decision time (G1 G2 G4): the tier names the role that may decide, in the
 * route-level guard (decide.ts) AND in the database (the in-memory RPC mirror of migration 0100),
 * and an emergency change takes its retro decision whether or not it has already gone live.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Actor } from "@/lib/auth/guard";
import { ApiError } from "@/lib/api/errors";
import { FakeDb, type Row } from "./test-support/fake-admin";

const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }));

vi.mock("@/lib/governance/project-files", () => ({ removeStoredFiles: async () => {} }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (holder.db as FakeDb).client }));
vi.mock("@/lib/integrations/emit", () => ({
  emitApprovalRequested: () => {},
  emitApprovalDecided: () => {},
  emitApprovalChanged: () => {},
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/auth/mfa", () => ({
  MFA_COOKIE_NAME: "nopm_mfa",
  getMfaEnrollmentStatus: async () => ({ enabled: false, enr: null }),
  verifyMfaCookie: () => false,
}));

import { approveDeletion, decideChangeRequest } from "./decide";

const WS = "ws-1";
const V0 = "2026-10-16T09:00:00.000Z";
const REQ = "11111111-1111-4111-8111-111111111111"; // a member who raised things
const MGR = "22222222-2222-4222-8222-222222222222";
const ADM = "33333333-3333-4333-8333-333333333333";
const ADM2 = "44444444-4444-4444-8444-444444444444";

const user = (id: string, role: string): Actor => ({
  type: "user",
  id,
  label: role,
  workspaceId: WS,
  role,
  principalId: id,
  channel: "ui",
  requestId: `req-${id}`,
});
const token = (owner: string, role: string): Actor =>
  ({
    type: "token",
    id: `tok-${owner}`,
    tokenId: `tok-${owner}`,
    label: "agent",
    workspaceId: WS,
    scopes: ["change:decide", "task:delete:approve", "project:delete:approve"],
    principalId: owner,
    principalRole: role,
    channel: "api",
  }) as Actor;

function cr(over: Row = {}): Row {
  return {
    id: "cr-1",
    workspace_id: WS,
    project_id: "proj-1",
    reference_id: "CR-001",
    title: "Extend go-live",
    status: "raised",
    tier: "normal",
    requested_by: REQ,
    requested_by_type: "user",
    requested_by_id: REQ,
    requested_by_label: "Rae",
    requested_principal_id: REQ,
    updated_at: V0,
    ...over,
  };
}

let db: FakeDb;
function seed(over: { cr?: Row; policy?: unknown; extra?: Record<string, Row[]> } = {}) {
  db = new FakeDb({
    workspaces: [{ id: WS, ...(over.policy ? { approval_policy: over.policy } : {}) }],
    projects: [{ id: "proj-1", workspace_id: WS, name: "Billing", is_locked: false }],
    profiles: [
      { id: REQ, workspace_id: WS, role: "member" },
      { id: MGR, workspace_id: WS, role: "manager" },
      { id: ADM, workspace_id: WS, role: "admin" },
      { id: ADM2, workspace_id: WS, role: "admin" },
    ],
    change_requests: [over.cr ?? cr()],
    audit_log: [],
    notifications: [],
    ...over.extra,
  });
  holder.db = db;
}

async function caught(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected the call to throw an ApiError");
}

const approve = { decision: "approve" as const, rationale: "ok", expected_updated_at: V0 };

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  seed();
});

describe("who may decide which tier (G2)", () => {
  it("a manager decides a normal request (the default)", async () => {
    const out = await decideChangeRequest(user(MGR, "manager"), "cr-1", approve);
    expect(out.result.status).toBe("approved");
  });

  it("a manager is refused a high_risk request: 403 role_not_permitted, nothing changes, nothing audited", async () => {
    seed({ cr: cr({ tier: "high_risk" }) });
    const err = await caught(decideChangeRequest(user(MGR, "manager"), "cr-1", approve));
    expect([err.status, err.code]).toEqual([403, "role_not_permitted"]);
    expect(err.message).toMatch(/admin/);
    expect(db.rows("change_requests")[0].status).toBe("raised");
    expect(db.rows("audit_log")).toHaveLength(0);
    expect(db.rpcCallsTo("nopm_decide_change_request")).toHaveLength(0);
  });

  it("an admin decides a high_risk request", async () => {
    seed({ cr: cr({ tier: "high_risk" }) });
    const out = await decideChangeRequest(user(ADM, "admin"), "cr-1", approve);
    expect(out.result.status).toBe("approved");
  });

  it("a token is judged by the role of the human who minted it", async () => {
    seed({ cr: cr({ tier: "strategic" }) });
    const err = await caught(decideChangeRequest(token(MGR, "manager"), "cr-1", approve));
    expect([err.status, err.code]).toEqual([403, "role_not_permitted"]);
    const ok = await decideChangeRequest(token(ADM, "admin"), "cr-1", approve);
    expect(ok.result.status).toBe("approved");
  });

  it("reject and defer are held to the same role", async () => {
    seed({ cr: cr({ tier: "high_risk" }) });
    for (const decision of ["reject", "defer"] as const) {
      const err = await caught(
        decideChangeRequest(user(MGR, "manager"), "cr-1", { decision, rationale: "no", expected_updated_at: V0 }),
      );
      expect(err.code).toBe("role_not_permitted");
    }
  });

  it("the workspace policy moves the line: normal can be admin-only", async () => {
    seed({ policy: { tiers: { normal: { approver_role: "admin" } } } });
    const err = await caught(decideChangeRequest(user(MGR, "manager"), "cr-1", approve));
    expect(err.code).toBe("role_not_permitted");
    const out = await decideChangeRequest(user(ADM, "admin"), "cr-1", approve);
    expect(out.result.status).toBe("approved");
  });

  it("a request raised before tiers existed (no tier) reads as normal", async () => {
    const legacy = cr();
    delete legacy.tier;
    seed({ cr: legacy });
    const out = await decideChangeRequest(user(MGR, "manager"), "cr-1", approve);
    expect(out.result.status).toBe("approved");
  });

  it("DB backstop: a caller that skips the route guard (claims admin) is still refused by the database for a manager's profile", async () => {
    seed({ cr: cr({ tier: "high_risk" }) });
    // The session CLAIMS admin, the profile row says manager: only the database can tell.
    const err = await caught(decideChangeRequest(user(MGR, "admin"), "cr-1", approve));
    expect([err.status, err.code]).toEqual([403, "role_not_permitted"]);
    expect(db.rpcCallsTo("nopm_decide_change_request")).toHaveLength(1);
    expect(db.rows("change_requests")[0].status).toBe("raised");
    expect(db.rows("audit_log")).toHaveLength(0);
  });
});

describe("W4-07 / D7: fewer than two admins -> a manager may decide an admin-level request", () => {
  it("with ONE admin, a manager decides a high_risk request and the decision audit row says fallback_approver", async () => {
    seed({ cr: cr({ tier: "high_risk" }) });
    db.tables.profiles = db.rows("profiles").filter((p) => p.id !== ADM2);
    const out = await decideChangeRequest(user(MGR, "manager"), "cr-1", approve);
    expect(out.result.status).toBe("approved");
    const audit = db.rows("audit_log").filter((a) => a.action === "change_request.decide");
    expect(audit).toHaveLength(1);
    expect((audit[0].after as Record<string, unknown>).fallback_approver).toBe(true);
  });

  it("with ONE admin, a manager still cannot be the second human for a request they raised themselves", async () => {
    seed({ cr: cr({ tier: "high_risk", requested_principal_id: MGR, requested_by: MGR, requested_by_id: MGR }) });
    db.tables.profiles = db.rows("profiles").filter((p) => p.id !== ADM2);
    const err = await caught(decideChangeRequest(user(MGR, "manager"), "cr-1", approve));
    expect(err.code).toBe("self_approval");
  });

  it("with TWO admins the fallback is closed: the manager is refused with the naming sentence", async () => {
    seed({ cr: cr({ tier: "high_risk" }) });
    const err = await caught(decideChangeRequest(user(MGR, "manager"), "cr-1", approve));
    expect([err.status, err.code, err.message]).toEqual([403, "role_not_permitted", "Only admins can approve a high-risk request."]);
  });

  it("an admin's decision never carries the fallback flag", async () => {
    seed({ cr: cr({ tier: "high_risk" }) });
    db.tables.profiles = db.rows("profiles").filter((p) => p.id !== ADM2);
    await decideChangeRequest(user(ADM, "admin"), "cr-1", approve);
    const audit = db.rows("audit_log").filter((a) => a.action === "change_request.decide");
    expect((audit[0].after as Record<string, unknown>).fallback_approver).toBeUndefined();
  });

  it("a deletion decided on the fallback gets one extra approval.fallback_approver audit row", async () => {
    seed({
      extra: {
        deletion_requests: [
          {
            id: "del-9", workspace_id: WS, target_type: "project", target_id: "proj-1", status: "pending", reason: "x",
            requested_by_type: "user", requested_by_id: REQ, requested_by_label: "Rae", requested_principal_id: REQ,
            tier: "high_risk", before: { id: "proj-1", name: "Billing" },
          },
        ],
      },
    });
    db.tables.profiles = db.rows("profiles").filter((p) => p.id !== ADM2);
    const out = await approveDeletion(token(MGR, "manager"), "del-9", { expectTarget: "project" });
    expect(out.result.status).toBe("committed");
    expect(db.rows("audit_log").filter((a) => a.action === "approval.fallback_approver")).toHaveLength(1);
  });
});

describe("deletion requests are routed too", () => {
  const del = (over: Row = {}): Row => ({
    id: "del-1",
    workspace_id: WS,
    target_type: "project",
    target_id: "proj-1",
    status: "pending",
    reason: "done",
    requested_by_type: "user",
    requested_by_id: REQ,
    requested_by_label: "Rae",
    requested_principal_id: REQ,
    tier: "high_risk",
    before: { id: "proj-1", name: "Billing" },
    ...over,
  });

  it("a manager cannot approve a high_risk project deletion (403); an admin can", async () => {
    seed({ extra: { deletion_requests: [del()] } });
    const err = await caught(approveDeletion(token(MGR, "manager"), "del-1", { expectTarget: "project" }));
    expect([err.status, err.code]).toEqual([403, "role_not_permitted"]);
    expect(db.rpcCallsTo("nopm_commit_project_deletion")).toHaveLength(0);
    const out = await approveDeletion(token(ADM, "admin"), "del-1", { expectTarget: "project" });
    expect(out.result.status).toBe("committed");
  });

  it("a manager still approves a normal task deletion", async () => {
    seed({
      extra: {
        tasks: [{ id: "task-1", workspace_id: WS, name: "T", project_id: "proj-1" }],
        deletion_requests: [del({ id: "del-2", target_type: "task", target_id: "task-1", tier: "normal", before: { id: "task-1", name: "T", project_id: "proj-1" } })],
      },
    });
    const out = await approveDeletion(token(MGR, "manager"), "del-2", { expectTarget: "task" });
    expect(out.result.status).toBe("committed");
  });
});

describe("Q1: an emergency change commits on raise and is never decided", () => {
  const emergency = (over: Row = {}) =>
    cr({
      tier: "emergency",
      is_emergency: true,
      status: "approved",
      requested_principal_id: MGR,
      requested_by: MGR,
      requested_by_id: MGR,
      retro_due_at: null,
      retro_decided_at: "2026-10-18T09:00:00.000Z",
      retro_outcome: "not_required",
      decided_at: "2026-10-18T09:00:00.000Z",
      ...over,
    });

  it("an admin cannot decide an emergency request: it is already approved", async () => {
    seed({ cr: emergency() });
    const err = await caught(decideChangeRequest(user(ADM, "admin"), "cr-1", approve));
    expect(err.code).toBe("already_decided");
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("a request still flagged as an emergency with a legacy 'emergency' status is not decidable either", async () => {
    seed({ cr: emergency({ status: "emergency" }) });
    const err = await caught(decideChangeRequest(user(ADM, "admin"), "cr-1", approve));
    expect(err.code).toBe("already_decided");
  });

  it("the database function refuses an emergency decision too (the backstop)", async () => {
    seed({ cr: emergency({ status: "raised" }) });
    const err = await caught(decideChangeRequest(user(ADM, "admin"), "cr-1", approve));
    expect(err.code).toBe("already_decided");
    expect(db.rows("change_requests")[0].status).toBe("raised");
  });

  it("a live emergency (implemented) owes no retro decision: it is refused as already decided", async () => {
    seed({ cr: emergency({ status: "implemented", implemented_at: "2026-10-17T10:00:00.000Z" }) });
    const err = await caught(decideChangeRequest(user(ADM, "admin"), "cr-1", approve));
    expect(err.code).toBe("already_decided");
  });

  it("an implemented NON-emergency request is never decidable", async () => {
    seed({ cr: cr({ status: "implemented", decided_at: "2026-10-16T00:00:00.000Z" }) });
    const err = await caught(decideChangeRequest(user(ADM, "admin"), "cr-1", approve));
    expect(err.code).toBe("already_decided");
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";

// resolveWorkspaceApprovers routes by tier (G2) and respects an assigned approver (G5).
const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));

import { FakeDb, TEST_ENCRYPTION_KEY, WS, ids, seedWorkspace } from "@/lib/integrations/test-support";
import { loadApprovalPolicy } from "@/lib/governance/tiers";
import { resolveWorkspaceApprovers } from "./publish";

let db: FakeDb;
beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  db = new FakeDb();
  state.db = db;
  seedWorkspace(db);
});

describe("resolveWorkspaceApprovers by tier", () => {
  it("no tier: every admin and manager, as before", async () => {
    const got = await resolveWorkspaceApprovers(WS);
    expect(new Set(got)).toEqual(new Set([ids.admin, ids.manager, ids.manager2, ids.requester]));
  });

  it("a manager-level tier reaches managers and admins, never members or viewers", async () => {
    const got = await resolveWorkspaceApprovers(WS, { tier: "normal" });
    expect(got).not.toContain(ids.member);
    expect(got).not.toContain(ids.viewer);
    expect(got).toEqual(expect.arrayContaining([ids.admin, ids.manager]));
  });

  it("an admin-level tier reaches admins only", async () => {
    expect(await resolveWorkspaceApprovers(WS, { tier: "high_risk" })).toEqual([ids.admin]);
    expect(await resolveWorkspaceApprovers(WS, { tier: "strategic" })).toEqual([ids.admin]);
    expect(await resolveWorkspaceApprovers(WS, { tier: "emergency" })).toEqual([ids.admin]);
  });

  it("follows the workspace policy", async () => {
    db.rows("workspaces")[0].approval_policy = { tiers: { normal: { approver_role: "admin" }, high_risk: { approver_role: "manager" } } };
    expect(await resolveWorkspaceApprovers(WS, { tier: "normal" })).toEqual([ids.admin]);
    expect(await resolveWorkspaceApprovers(WS, { tier: "high_risk" })).toEqual(expect.arrayContaining([ids.admin, ids.manager]));
  });

  it("an assigned approver gets it alone, but only when eligible for the tier", async () => {
    expect(await resolveWorkspaceApprovers(WS, { tier: "normal", assignedApproverId: ids.manager })).toEqual([ids.manager]);
    // a manager assigned to an admin-level request is not eligible: the tier's audience is used
    expect(await resolveWorkspaceApprovers(WS, { tier: "high_risk", assignedApproverId: ids.manager })).toEqual([ids.admin]);
  });
});

describe("loadApprovalPolicy", () => {
  it("falls back to the defaults when the column or the row is missing", async () => {
    const p = await loadApprovalPolicy(db as never, "no-such-workspace");
    expect(p.tiers.high_risk.approver_role).toBe("admin");
    db.failNext({ table: "workspaces", op: "select", error: { message: "column approval_policy does not exist" } });
    expect((await loadApprovalPolicy(db as never, WS)).currency_threshold).toBe(50_000);
  });
});

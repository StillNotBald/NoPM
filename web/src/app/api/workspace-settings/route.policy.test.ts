import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

// The approval policy in /api/workspace-settings (G1 G3 G4 G7).
const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { writeAuditMock, requireAuthMock } = vi.hoisted(() => ({
  writeAuditMock: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
  requireAuthMock: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/audit/write", () => ({ writeAudit: writeAuditMock }));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: requireAuthMock,
}));

import { FakeDb, TEST_ENCRYPTION_KEY, WS, ids, seedWorkspace } from "@/lib/integrations/test-support";
import { GET, PATCH } from "./route";

const NO_PARAMS = { params: Promise.resolve({}) };
const actor = (role: string): Actor => ({ type: "user", id: ids.admin, label: "A", workspaceId: WS, role, principalId: ids.admin }) as Actor;
const patch = (body: unknown) =>
  PATCH(new NextRequest("http://localhost:3000/api/workspace-settings", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), NO_PARAMS);
const get = async () => (await (await GET(new NextRequest("http://localhost:3000/api/workspace-settings"), NO_PARAMS)).json()).data;
const stored = () => db.rows("workspaces").find((w) => w.id === WS)!.approval_policy as Policy | undefined;

type Policy = { tiers: Record<string, Record<string, unknown>>; [key: string]: unknown };
type AuditCall = { action: string; before: { approval_policy: Policy }; after: { approval_policy: Policy } };

let db: FakeDb;
const audits = () => db.rows("audit_log").filter((a) => a.action === "workspace.settings_update");
beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  writeAuditMock.mockReset();
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue(actor("admin"));
  db = new FakeDb();
  state.db = db;
  seedWorkspace(db);
});

describe("approval_policy in /api/workspace-settings", () => {
  it("GET returns the full policy with every default filled in, auto-approve off", async () => {
    const { approval_policy: p } = await get();
    expect(p.tiers.routine).toMatchObject({ approver_role: "manager", auto_approve: false });
    expect(p.tiers.high_risk.approver_role).toBe("admin");
    expect(p.tiers.emergency.approver_role).toBe("admin");
    expect(p.currency_threshold).toBe(50_000);
    expect(p).not.toHaveProperty("emergency_retro_hours"); // retired (D17)
  });

  it("PATCH changes only what was sent, stores the complete policy, and writes ONE audit row with before and after", async () => {
    const res = await patch({ approval_policy: { tiers: { high_risk: { turnaround_hours: 24 } }, currency_threshold: 20000, currency: "myr" } });
    expect(res.status).toBe(200);
    expect(stored()!.tiers.high_risk).toMatchObject({ turnaround_hours: 24, approver_role: "admin" });
    expect(stored()!.tiers.normal).toMatchObject({ approver_role: "manager" }); // untouched, still complete
    expect(stored()).toMatchObject({ currency_threshold: 20000, currency: "MYR" });
    expect(audits()).toHaveLength(1);
    const call = audits()[0] as unknown as AuditCall;
    expect(call.action).toBe("workspace.settings_update");
    expect(call.before.approval_policy.currency_threshold).toBe(50_000);
    expect(call.after.approval_policy.currency_threshold).toBe(20000);
  });

  it("a second PATCH of the same policy writes nothing and no audit row", async () => {
    await patch({ approval_policy: { currency_threshold: 20000 } });
    db.tables.audit_log = [];
    await patch({ approval_policy: { currency_threshold: 20000 } });
    expect(audits()).toHaveLength(0);
  });

  it("an admin can switch routine auto-approve on, and it is in the audit row", async () => {
    await patch({ approval_policy: { tiers: { routine: { auto_approve: true } } } });
    expect(stored()!.tiers.routine.auto_approve).toBe(true);
    expect((audits()[0] as unknown as AuditCall).after.approval_policy.tiers.routine.auto_approve).toBe(true);
  });

  it.each([
    ["auto_approve on normal", { tiers: { normal: { auto_approve: true } } }],
    ["auto_approve on emergency", { tiers: { emergency: { auto_approve: true } } }],
    ["a bad role", { tiers: { normal: { approver_role: "member" } } }],
    ["an unknown tier", { tiers: { urgent: { approver_role: "admin" } } }],
    ["negative turnaround", { tiers: { normal: { turnaround_hours: -3 } } }],
    ["a negative threshold", { currency_threshold: -1 }],
  ])("refuses %s with 422 naming the field, and changes and audits nothing", async (_l, policy) => {
    const res = await patch({ approval_policy: policy });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.fields?.length).toBeGreaterThan(0);
    expect(stored()).toBeUndefined();
    expect(audits()).toHaveLength(0);
  });

  it("is admin-only: a manager is refused with 403 and nothing is stored", async () => {
    requireAuthMock.mockResolvedValue(actor("manager"));
    expect((await patch({ approval_policy: { currency_threshold: 1 } })).status).toBe(403);
    expect(stored()).toBeUndefined();
  });

  it("W4-03: the write and its audit row are one RPC call carrying the pinned values; a failing RPC leaves nothing and surfaces", async () => {
    const calls: Array<{ name?: string; args: Record<string, unknown> }> = [];
    const real = db.rpc.bind(db);
    db.rpc = async (name?: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      if (name === "nopm_update_workspace_settings") return { data: null, error: { code: "XX000", message: "boom" }, count: null };
      return real(name, args);
    };
    const res = await patch({ approval_policy: { currency_threshold: 1 } });
    expect(res.status).toBe(500);
    expect(stored()).toBeUndefined();
    expect(audits()).toHaveLength(0);
    const call = calls.find((c) => c.name === "nopm_update_workspace_settings")!;
    expect(call.args.p_patch).toMatchObject({ approval_policy: { currency_threshold: 1 } });
    expect(call.args.p_audit).toMatchObject({ action: "workspace.settings_update", target_type: "workspace" });
    // the route never updates the table itself any more
    expect(db.log.filter((l) => l.table === "workspaces" && l.op === "update")).toHaveLength(0);
  });

  it("W4-03: two admins saving at once: the second one gets 412, not a silent overwrite", async () => {
    const real = db.rpc.bind(db);
    db.rpc = async (name?: string, args: Record<string, unknown> = {}) => {
      if (name === "nopm_update_workspace_settings") {
        // the other admin's save lands between this admin's read and write
        db.rows("workspaces").find((w) => w.id === WS)!.stale_days = 99;
      }
      return real(name, args);
    };
    const res = await patch({ stale_days: 30 });
    expect(res.status).toBe(412);
    expect(db.rows("workspaces").find((w) => w.id === WS)!.stale_days).toBe(99);
    expect(audits()).toHaveLength(0);
  });

  it("W4-06: the schedule threshold is part of the policy (default 10, validated)", async () => {
    expect((await get()).approval_policy.schedule_threshold_days).toBe(10);
    expect((await get()).approval_policy.currency).toBe("MYR");
    expect((await patch({ approval_policy: { schedule_threshold_days: 5 } })).status).toBe(200);
    expect(stored()!.schedule_threshold_days).toBe(5);
    expect((await patch({ approval_policy: { schedule_threshold_days: -2 } })).status).toBe(422);
  });

  it("the retired emergency_retro_hours is accepted and ignored, even when out of range, and never returned", async () => {
    const res = await patch({ approval_policy: { emergency_retro_hours: 0, currency: "MYR" } });
    expect(res.status).toBe(200);
    expect((await get()).approval_policy).not.toHaveProperty("emergency_retro_hours");
    expect((await get()).approval_policy.currency).toBe("MYR");
  });

  it("works alongside the other settings in one PATCH", async () => {
    const res = await patch({ stale_days: 30, approval_policy: { emergency_retro_hours: 24 } });
    expect(res.status).toBe(200);
    expect(db.rows("workspaces").find((w) => w.id === WS)).toMatchObject({ stale_days: 30 });
    // retired (Q1, D17): accepted, not stored, not returned
    expect((await get()).approval_policy).not.toHaveProperty("emergency_retro_hours");
    expect(audits()).toHaveLength(1);
  });
});

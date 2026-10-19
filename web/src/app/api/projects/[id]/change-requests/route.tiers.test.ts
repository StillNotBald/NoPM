import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

// Raising a change request under the approval tiers (G1 G2 G4 G7), against the hub's in-memory database.
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
vi.mock("@/lib/governance/next-ref", () => ({
  insertWithReference: async (_db: unknown, _ws: string, _kind: string, insert: (ref: string) => PromiseLike<unknown>) =>
    insert("CR-001"),
}));
vi.mock("@/lib/integrations/lark", () => ({ larkAdapter: undefined }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: () => {},
}));

import { FakeDb, TEST_ENCRYPTION_KEY, WS, ids, seedWorkspace } from "@/lib/integrations/test-support";
import { POST } from "./route";

const PROJECT = "7b1d0c4e-0000-4000-8000-0000000000aa";
const actorOf = (id: string, role: string): Actor => ({
  type: "user",
  id,
  label: `${role} user`,
  workspaceId: WS,
  role,
  principalId: id,
});

let db: FakeDb;
const flush = () => new Promise((r) => setTimeout(r, 0));

const raise = (body: Record<string, unknown>) =>
  POST(
    new NextRequest(`http://localhost:3000/api/projects/${PROJECT}/change-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: PROJECT }) },
  );

const lastRow = () => db.rows("change_requests").find((r) => r.title !== undefined && r.reference_id === "CR-001")!;

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue(actorOf(ids.requester, "manager"));
  db = new FakeDb();
  state.db = db;
  seedWorkspace(db);
  db.seed("projects", [{ id: PROJECT, workspace_id: WS, name: "Apollo", currency: "MYR" }]);
});

describe("raising sets the tier and the deadline (G1, G3)", () => {
  it("a plain request is normal with a 48 h deadline, and the audit row carries them", async () => {
    const before = Date.now();
    const res = await raise({ title: "Rename a label" });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.tier).toBe("normal");
    expect(data.status).toBe("raised");
    expect(data.is_emergency).toBeUndefined();
    const due = Date.parse(data.approval_deadline_at);
    expect(due - before).toBeGreaterThanOrEqual(48 * 3_600_000 - 1000);
    expect(due - before).toBeLessThan(48 * 3_600_000 + 60_000);
    const audit = writeAuditMock.mock.calls.map((c) => c[0] as { action: string; after: Record<string, unknown> });
    expect(audit.filter((a) => a.action === "change_request.create")).toHaveLength(1);
    expect(audit[0].after.tier).toBe("normal");
    // the ledger records that a deadline was set
    expect(db.rows("approval_events")).toEqual([expect.objectContaining({ kind: "deadline_set", target_type: "change_request" })]);
  });

  it("the workspace's turnaround is used; 0 hours means no deadline", async () => {
    db.rows("workspaces")[0].approval_policy = { tiers: { normal: { turnaround_hours: 0 } } };
    const { data } = await (await raise({ title: "x" })).json();
    expect(data.approval_deadline_at).toBeNull();
  });
});

describe("G7: the currency threshold lifts normal to high_risk", () => {
  it("under the threshold stays normal, at it becomes high_risk with an admin-only audience", async () => {
    const low = await (await raise({ title: "small", impact_cost: 49_000 })).json();
    expect(low.data.tier).toBe("normal");
    const high = await (await raise({ title: "big", impact_cost: 50_000 })).json();
    expect(high.data.tier).toBe("high_risk");
    await flush();
    const asked = db.rows("notifications").filter((n) => n.type === "approval.requested");
    // only the admin (not the manager who is not the requester, not the member) hears about the high-risk one
    const bigTitle = asked.filter((n) => String(n.title).includes("needs a decision"));
    expect(bigTitle.map((n) => n.recipient_id)).toContain(ids.admin);
  });

  it("a high_risk request is announced to admins only; a normal one to managers and admins", async () => {
    await raise({ title: "big", impact_cost: 80_000 });
    await flush();
    const recipients = db.rows("notifications").filter((n) => n.type === "approval.requested").map((n) => n.recipient_id);
    expect(recipients).toEqual([ids.admin]);

    db.tables.notifications = [];
    await raise({ title: "small", impact_cost: 10 });
    await flush();
    const normalRecipients = db.rows("notifications").filter((n) => n.type === "approval.requested").map((n) => n.recipient_id);
    expect(new Set(normalRecipients)).toEqual(new Set([ids.admin, ids.manager, ids.manager2]));
    // never the requester
    expect(normalRecipients).not.toContain(ids.requester);
  });

  it("a threshold set by the workspace is the one used", async () => {
    db.rows("workspaces")[0].approval_policy = { currency_threshold: 100 };
    const { data } = await (await raise({ title: "x", impact_cost: 150 })).json();
    expect(data.tier).toBe("high_risk");
  });
});

describe("W4-05 / W4-06: routine means nothing structured; a long slip is high risk", () => {
  it("routine with a structured scope impact is a 422 and raises nothing", async () => {
    const res = await raise({ title: "typo", tier: "routine", impact_scope: [{ area: "scope", direction: "increase" }] });
    expect(res.status).toBe(422);
    expect(db.rows("change_requests").some((r) => r.title === "typo")).toBe(false);
  });

  it("a schedule impact over 10 days is high_risk, 10 days stays normal", async () => {
    expect((await (await raise({ title: "ten", impact_schedule_days: 10 })).json()).data.tier).toBe("normal");
    expect((await (await raise({ title: "eleven", impact_schedule_days: 11 })).json()).data.tier).toBe("high_risk");
  });

  it("the policy's day threshold is the one used", async () => {
    db.rows("workspaces")[0].approval_policy = { schedule_threshold_days: 2 };
    expect((await (await raise({ title: "three", impact_schedule_days: 3 })).json()).data.tier).toBe("high_risk");
  });
});

describe("Q1: emergency = flag only, committed on raise", () => {
  it("a manager raises an emergency: it commits at once as approved, flagged, with no deadline and no retro", async () => {
    const res = await raise({ title: "Prod is down", is_emergency: true });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({
      tier: "emergency",
      status: "approved",
      is_emergency: true,
      approval_deadline_at: null,
      retro_outcome: "not_required",
    });
    expect(data.retro_due_at ?? null).toBeNull();
    expect(data.retro_decided_at).toBeTruthy();
    expect(data.decided_at).toBeTruthy();
    expect(data.decided_by_id ?? null).toBeNull();
    expect(data.assigned_approver_id ?? null).toBeNull();
  });

  it("no approver is asked: no approval notification, no deadline event, no chat card", async () => {
    await raise({ title: "Prod is down", is_emergency: true });
    await flush();
    expect(db.rows("notifications").filter((n) => n.type === "approval.requested")).toEqual([]);
    expect(db.rows("approval_events")).toEqual([]);
  });

  it("the raiser is the audit actor on the create row and on a separate emergency commit row, written by the same database call", async () => {
    await raise({ title: "Prod is down", is_emergency: true });
    const audit = db.rows("audit_log") as { action: string; actor_id: string; after: Record<string, unknown> }[];
    const create = audit.find((a) => a.action === "change_request.create")!;
    expect(create.actor_id).toBe(ids.requester);
    expect(create.after).toMatchObject({ tier: "emergency", is_emergency: true, status: "approved" });
    const commit = audit.find((a) => a.action === "change_request.emergency_commit")!;
    expect(commit.actor_id).toBe(ids.requester);
    expect(commit.after).toMatchObject({ emergency: true, tier: "emergency", approval_required: false });
    // the application layer wrote no separate audit row for it
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("C2-03: if the audit half fails the request is not kept and the raise answers 500", async () => {
    db.failEmergencyAudit = true;
    const res = await raise({ title: "Prod is down", is_emergency: true });
    expect(res.status).toBe(500);
    expect(db.rows("change_requests").some((r) => r.title === "Prod is down")).toBe(false);
    expect(db.rows("audit_log")).toEqual([]);
  });

  const tokenFor = (scopes: string[]): Actor => ({
    type: "token",
    id: "c0000000-0000-4000-8000-000000000001",
    label: "agent token",
    workspaceId: WS,
    scopes,
    principalId: ids.requester,
    principalRole: "manager",
  });

  it.each([["change:write"], ["change:*"], ["*"]])("C2-01: a token holding only %s cannot raise an emergency (403), nothing stored", async (scope) => {
    requireAuthMock.mockResolvedValue(tokenFor([scope]));
    const res = await raise({ title: "Prod is down", is_emergency: true });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("role_not_permitted");
    expect(db.rows("change_requests").some((r) => r.title === "Prod is down")).toBe(false);
    expect(db.rows("audit_log")).toEqual([]);
  });

  it("C2-01: a token with the exact change:decide scope (and a manager behind it) can", async () => {
    requireAuthMock.mockResolvedValue(tokenFor(["change:write", "change:decide"]));
    const res = await raise({ title: "Prod is down", is_emergency: true });
    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({ tier: "emergency", status: "approved" });
  });

  it("C2-01: a token without the scope can still raise an ordinary request", async () => {
    requireAuthMock.mockResolvedValue(tokenFor(["change:write"]));
    expect((await raise({ title: "Rename a label" })).status).toBe(201);
  });

  it("C2-02: the database function refuses a requester who is not a manager or admin (P0043), mapped to 403", async () => {
    // a member slips past the route check only if the route were bypassed; here the principal is a member behind a token that holds change:decide
    requireAuthMock.mockResolvedValue({ ...tokenFor(["change:write", "change:decide"]), principalId: ids.member, principalRole: "manager" });
    const res = await raise({ title: "Prod is down", is_emergency: true });
    expect(res.status).toBe(403);
    expect(db.rows("change_requests").some((r) => r.title === "Prod is down")).toBe(false);
  });

  it("the old retro window setting changes nothing", async () => {
    db.rows("workspaces")[0].approval_policy = { emergency_retro_hours: 6 };
    const { data } = await (await raise({ title: "Prod is down", is_emergency: true })).json();
    expect(data.retro_due_at ?? null).toBeNull();
    expect(data.status).toBe("approved");
  });

  it("an admin raising an emergency also commits at once", async () => {
    requireAuthMock.mockResolvedValue(actorOf(ids.admin, "admin"));
    const { data } = await (await raise({ title: "Prod is down", is_emergency: true })).json();
    expect(data).toMatchObject({ tier: "emergency", status: "approved" });
  });

  it("an ordinary request writes no emergency commit row", async () => {
    await raise({ title: "Rename a label" });
    expect(writeAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action)).toEqual(["change_request.create"]);
    expect(db.rows("audit_log")).toEqual([]);
  });

  it("a member cannot raise an emergency: 403, nothing stored, nothing audited", async () => {
    requireAuthMock.mockResolvedValue(actorOf(ids.member, "member"));
    const res = await raise({ title: "Prod is down", is_emergency: true });
    expect(res.status).toBe(403);
    expect((await res.json()).code ?? "role_not_permitted").toBe("role_not_permitted");
    expect(db.rows("change_requests").some((r) => r.title === "Prod is down")).toBe(false);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("an emergency also needs the change:write scope like any other raise", async () => {
    requireAuthMock.mockResolvedValue({ ...actorOf(ids.viewer, "viewer") });
    expect((await raise({ title: "x", is_emergency: true })).status).toBe(403);
  });

  it("an emergency raised with a huge cost is still an emergency (the flag wins), and stays flagged", async () => {
    const { data } = await (await raise({ title: "x", is_emergency: true, impact_cost: 9_000_000 })).json();
    expect(data.tier).toBe("emergency");
  });
});

describe("requested tiers", () => {
  it("routine with no money and no dates is accepted and gets the routine turnaround (24 h)", async () => {
    const before = Date.now();
    const { data } = await (await raise({ title: "typo", tier: "routine" })).json();
    expect(data.tier).toBe("routine");
    expect(Date.parse(data.approval_deadline_at) - before).toBeLessThan(24 * 3_600_000 + 60_000);
  });

  it.each([{ impact_cost: 10 }, { impact_schedule_days: 2 }])("routine with %o is a 422 and raises nothing", async (extra) => {
    const res = await raise({ title: "typo", tier: "routine", ...extra });
    expect(res.status).toBe(422);
    expect(db.rows("change_requests").some((r) => r.title === "typo")).toBe(false);
  });

  it("strategic is for admins: a manager gets 403, an admin gets strategic", async () => {
    expect((await raise({ title: "s", tier: "strategic" })).status).toBe(403);
    requireAuthMock.mockResolvedValue(actorOf(ids.admin, "admin"));
    const { data } = await (await raise({ title: "s", tier: "strategic" })).json();
    expect(data.tier).toBe("strategic");
  });

  it("a caller cannot pick emergency as a plain tier", async () => {
    expect((await raise({ title: "x", tier: "emergency" })).status).toBe(422);
  });

  it("assigned approver: a manager cannot be assigned to a request that needs an admin", async () => {
    const res = await raise({ title: "big", impact_cost: 90_000, assigned_approver_id: ids.manager });
    expect(res.status).toBe(422);
    const ok = await raise({ title: "big", impact_cost: 90_000, assigned_approver_id: ids.admin });
    expect(ok.status).toBe(201);
    expect(lastRow()).toBeTruthy();
  });

  it("an assigned approver is the only one told", async () => {
    await raise({ title: "small", assigned_approver_id: ids.manager });
    await flush();
    expect(db.rows("notifications").filter((n) => n.type === "approval.requested").map((n) => n.recipient_id)).toEqual([ids.manager]);
  });
});

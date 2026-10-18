/**
 * POST /api/change-requests/:id/review (Q-GOV-3) and /reopen (decision 24):
 * the two audited status moves that are not a decision.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";

const { holder, authHolder, emitted } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  authHolder: { actor: null as unknown },
  emitted: { requested: [] as unknown[], changed: [] as unknown[] },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (holder.db as FakeDb).client,
}));
vi.mock("@/lib/integrations/emit", () => ({
  emitApprovalRequested: (ev: unknown) => void emitted.requested.push(ev),
  emitApprovalDecided: () => {},
  emitApprovalChanged: (ev: unknown) => void emitted.changed.push(ev),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/auth/mfa", () => ({
  MFA_COOKIE_NAME: "nopm_mfa",
  getMfaEnrollmentStatus: async () => ({ enabled: false, enr: null }),
  verifyMfaCookie: () => false,
}));
vi.mock("@/lib/auth/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guard")>();
  return { ...actual, requireAuth: async () => authHolder.actor as Actor };
});

import { POST as review } from "./review/route";
import { POST as reopen } from "./reopen/route";

const WS = "ws-1";
const ALICE = "11111111-1111-4111-8111-111111111111"; // requester, a member
const BOB = "22222222-2222-4222-8222-222222222222"; // manager
const CAROL = "33333333-3333-4333-8333-333333333333"; // another member

const user = (id: string, role: string): Actor => ({
  type: "user",
  id,
  label: id,
  workspaceId: WS,
  role,
  principalId: id,
  channel: "ui",
  requestId: `req-${id}`,
});

let db: FakeDb;
const cr = (id = "cr-1") => db.rows("change_requests").find((r) => r.id === id)!;
const post = (handler: typeof review, actor: Actor, id = "cr-1") => {
  authHolder.actor = actor;
  return handler(new NextRequest(`http://localhost/api/change-requests/${id}/x`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
};

beforeEach(() => {
  emitted.requested.length = 0;
  emitted.changed.length = 0;
  db = new FakeDb({
    projects: [{ id: "p1", workspace_id: WS, name: "Billing" }],
    change_requests: [
      { id: "cr-1", workspace_id: WS, project_id: "p1", reference_id: "CR-001", title: "Slip", status: "raised", requested_by: ALICE, requested_by_type: "user", requested_by_id: ALICE, requested_by_label: "alice", requested_principal_id: ALICE, updated_at: "2026-10-16T09:00:00.000Z" },
      { id: "cr-2", workspace_id: WS, project_id: "p1", reference_id: "CR-002", title: "Parked", status: "deferred", requested_by: ALICE, requested_by_type: "user", requested_by_id: ALICE, requested_by_label: "alice", requested_principal_id: ALICE, decided_by: BOB, decided_by_label: "bob", decided_by_type: "user", decided_by_id: BOB, decided_principal_id: BOB, decision_rationale: "next quarter", decided_at: "2026-10-10T00:00:00Z", updated_at: "2026-10-16T09:00:00.000Z" },
    ],
    profiles: [
      { id: ALICE, workspace_id: WS, role: "member" },
      { id: BOB, workspace_id: WS, role: "manager" },
      { id: CAROL, workspace_id: WS, role: "member" },
    ],
    audit_log: [],
  });
  holder.db = db;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("Q-GOV-3 — start review", () => {
  it("a manager moves a raised request to under_review, with one audit row", async () => {
    const res = await post(review, user(BOB, "manager"));
    expect(res.status).toBe(200);
    expect(cr().status).toBe("under_review");
    expect(db.rows("audit_log").map((a) => a.action)).toEqual(["change_request.start_review"]);
    expect(emitted.changed).toHaveLength(1); // old cards retired, fresh one issued
  });

  it("a member is refused (403 role_not_permitted)", async () => {
    const res = await post(review, user(CAROL, "member"));
    expect(res.status).toBe(403);
    expect(cr().status).toBe("raised");
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("a request that is not raised is a 422 invalid_transition", async () => {
    const res = await post(review, user(BOB, "manager"), "cr-2");
    expect([res.status, (await res.json()).code]).toEqual([422, "invalid_transition"]);
  });
});

describe("decision 24 — a deferred request is parked and can be reopened", () => {
  it("the requester reopens: under_review, the defer decision cleared, one audit row, fresh approval card", async () => {
    const res = await post(reopen, user(ALICE, "member"), "cr-2");
    expect(res.status).toBe(200);
    expect(cr("cr-2")).toMatchObject({
      status: "under_review",
      decided_by_id: null,
      decided_principal_id: null,
      decision_rationale: null,
      decided_at: null,
    });
    const audit = db.rows("audit_log");
    expect(audit.map((a) => a.action)).toEqual(["change_request.reopen"]);
    expect((audit[0].before as { status: string; decision_rationale: string }).decision_rationale).toBe("next quarter");
    expect(emitted.requested).toHaveLength(1);
  });

  it("a manager can reopen someone else's parked request", async () => {
    const res = await post(reopen, user(BOB, "manager"), "cr-2");
    expect(res.status).toBe(200);
  });

  it("another member cannot (403 not_requester)", async () => {
    const res = await post(reopen, user(CAROL, "member"), "cr-2");
    expect([res.status, (await res.json()).code]).toEqual([403, "not_requester"]);
    expect(cr("cr-2").status).toBe("deferred");
  });

  it("only a deferred request can be reopened (422 invalid_transition)", async () => {
    const res = await post(reopen, user(ALICE, "member"), "cr-1");
    expect([res.status, (await res.json()).code]).toEqual([422, "invalid_transition"]);
  });

  it("a viewer is refused by scope", async () => {
    expect((await post(reopen, user(ALICE, "viewer"), "cr-2")).status).toBe(403);
  });
});

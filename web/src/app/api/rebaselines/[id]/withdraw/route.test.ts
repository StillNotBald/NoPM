/**
 * POST /api/rebaselines/:id/withdraw (Q-GOV-7): the proposer withdraws their own
 * rebaseline while it awaits sign-off; nobody else can, and a decided one stays.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";

const { holder, authHolder, emitted } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  authHolder: { actor: null as unknown },
  emitted: { decided: [] as unknown[] },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (holder.db as FakeDb).client,
}));
vi.mock("@/lib/integrations/emit", () => ({
  emitApprovalRequested: () => {},
  emitApprovalDecided: (ev: unknown) => void emitted.decided.push(ev),
  emitApprovalChanged: () => {},
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

import { POST } from "./route";

const WS = "ws-1";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const P1 = "44444444-4444-4444-8444-444444444444";

const user = (id: string, role = "manager"): Actor => ({
  type: "user",
  id,
  label: id === ALICE ? "alice" : "bob",
  workspaceId: WS,
  role,
  principalId: id,
  channel: "ui",
  requestId: `req-${id}`,
});

let db: FakeDb;
const call = (actor: Actor, id = "rb-1") => {
  authHolder.actor = actor;
  return POST(new NextRequest(`http://localhost/api/rebaselines/${id}/withdraw`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
};

beforeEach(() => {
  emitted.decided.length = 0;
  db = new FakeDb({
    projects: [{ id: P1, workspace_id: WS, name: "Billing", is_locked: true }],
    rebaselines: [
      { id: "rb-1", workspace_id: WS, project_id: P1, version: 1, status: "pending_approval", requested_by: ALICE, requested_principal_id: ALICE },
      { id: "rb-2", workspace_id: WS, project_id: P1, version: 2, status: "approved", requested_by: ALICE, requested_principal_id: ALICE },
    ],
    profiles: [
      { id: ALICE, workspace_id: WS, role: "manager" },
      { id: BOB, workspace_id: WS, role: "manager" },
    ],
    audit_log: [],
  });
  holder.db = db;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("withdraw a rebaseline", () => {
  it("the proposer withdraws: status cancelled, one audit row, cards retired", async () => {
    const res = await call(user(ALICE));
    expect(res.status).toBe(200);
    expect(db.rows("rebaselines")[0].status).toBe("cancelled");
    const audit = db.rows("audit_log");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "rebaseline.withdrawn", target_id: "rb-1" });
    expect(emitted.decided[0]).toMatchObject({ kind: "rebaseline_signoff", status: "withdrawn" });
  });

  it("someone else cannot (403 not_requester) and nothing changes", async () => {
    const res = await call(user(BOB));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("not_requester");
    expect(db.rows("rebaselines")[0].status).toBe("pending_approval");
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("an approved rebaseline can no longer be withdrawn (422 rebaseline_not_pending)", async () => {
    const res = await call(user(ALICE), "rb-2");
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("rebaseline_not_pending");
  });

  it("a viewer is refused by scope", async () => {
    const res = await call(user(ALICE, "viewer"));
    expect(res.status).toBe(403);
  });

  it("unknown id is a 404", async () => {
    expect((await call(user(ALICE), "nope")).status).toBe(404);
  });

});

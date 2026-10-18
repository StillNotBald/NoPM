/**
 * POST /api/change-requests/:id/implement (M2, assumption A2): the "approved, then
 * live" proof. Routes run for real over the in-memory governed database; the RPC
 * is the fake mirror of migration 0092 (same guard order and errcodes).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";

const { holder, authHolder } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  authHolder: { actor: null as unknown },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (holder.db as FakeDb).client,
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
const ALICE = "11111111-1111-4111-8111-111111111111"; // requester, a member
const BOB = "22222222-2222-4222-8222-222222222222"; // manager
const CAROL = "33333333-3333-4333-8333-333333333333"; // another member

const user = (id: string, role: string): Actor => ({
  type: "user",
  id,
  label: `label-${id.slice(0, 2)}`,
  workspaceId: WS,
  role,
  principalId: id,
  channel: "ui",
  requestId: `req-${id}`,
});

let db: FakeDb;
const cr = (id = "cr-1") => db.rows("change_requests").find((r) => r.id === id)!;

const post = (actor: Actor, body?: unknown, id = "cr-1") => {
  authHolder.actor = actor;
  return POST(
    new NextRequest(`http://localhost/api/change-requests/${id}/implement`, {
      method: "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id }) },
  );
};

const base = {
  workspace_id: WS,
  project_id: "p1",
  title: "Slip",
  requested_by: ALICE,
  requested_by_type: "user",
  requested_by_id: ALICE,
  requested_by_label: "alice",
  requested_principal_id: ALICE,
  updated_at: "2026-10-16T09:00:00.000Z",
};
const decided = {
  decided_by: BOB,
  decided_by_label: "bob",
  decided_by_type: "user",
  decided_by_id: BOB,
  decided_principal_id: BOB,
  decided_at: "2026-10-17T00:00:00.000Z",
};

beforeEach(() => {
  db = new FakeDb({
    projects: [{ id: "p1", workspace_id: WS, name: "Billing" }],
    change_requests: [
      { ...base, id: "cr-1", reference_id: "CR-001", status: "approved", ...decided },
      { ...base, id: "cr-2", reference_id: "CR-002", status: "raised" },
      { ...base, id: "cr-4", reference_id: "CR-004", status: "approved", requested_by: null, requested_by_id: null, requested_principal_id: null, ...decided },
      { ...base, id: "cr-5", reference_id: "CR-005", status: "approved", requested_by: CAROL, requested_by_id: null, requested_principal_id: null, ...decided },
      { ...base, id: "cr-3", reference_id: "CR-003", status: "rejected", ...decided },
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

describe("M2 - mark an approved change request implemented", () => {
  it("the requester marks it: status implemented, stamped, ONE audit row with before/after", async () => {
    const res = await post(user(ALICE, "member"), { note: "Released in 4.2" });
    expect(res.status).toBe(200);
    const row = (await res.json()).data;
    expect(row.status).toBe("implemented");
    expect(cr()).toMatchObject({
      status: "implemented",
      implemented_by: ALICE,
      implemented_by_type: "user",
      implemented_by_id: ALICE,
      implemented_principal_id: ALICE,
      implemented_note: "Released in 4.2",
    });
    // the stamp can never be earlier than the decision (the CHECK in the database)
    expect(Date.parse(String(cr().implemented_at))).toBeGreaterThanOrEqual(Date.parse(String(cr().decided_at)));

    const audit = db.rows("audit_log");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "change_request.implement",
      target_type: "change_request",
      target_id: "cr-1",
      actor_type: "user",
      actor_id: ALICE,
      channel: "ui",
      request_id: `req-${ALICE}`,
      principal_id: ALICE,
    });
    expect((audit[0].before as { status: string }).status).toBe("approved");
    expect((audit[0].after as { status: string; implemented_at: string }).status).toBe("implemented");
    expect((audit[0].after as { implemented_at: string }).implemented_at).toBeTruthy();
  });

  it("a manager (not the requester) may mark it, and the note is optional", async () => {
    const res = await post(user(BOB, "manager"));
    expect(res.status).toBe(200);
    expect(cr()).toMatchObject({ status: "implemented", implemented_principal_id: BOB, implemented_note: null });
  });

  it("another member is refused (403 not_requester) and nothing changes", async () => {
    const res = await post(user(CAROL, "member"));
    expect([res.status, (await res.json()).code]).toEqual([403, "not_requester"]);
    expect(cr().status).toBe("approved");
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("a member who is not the requester is refused 403 (never audited as the implementer)", async () => {
    const res = await post(user(CAROL, "member"), undefined, "cr-1");
    expect(res.status).toBe(403);
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("a request with no requester principal: a member is refused 403, a manager may implement", async () => {
    const denied = await post(user(CAROL, "member"), undefined, "cr-4");
    expect(denied.status).toBe(403);
    expect(cr("cr-4").status).toBe("approved");
    expect(db.rows("audit_log")).toHaveLength(0);
    const ok = await post(user(BOB, "manager"), undefined, "cr-4");
    expect(ok.status).toBe(200);
    expect(cr("cr-4")).toMatchObject({ status: "implemented", implemented_principal_id: BOB });
  });

  it("legacy requested_by set, principal NULL, caller = requested_by: 403", async () => {
    const res = await post(user(CAROL, "member"), undefined, "cr-5");
    expect(res.status).toBe(403);
    expect(cr("cr-5").status).toBe("approved");
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("a viewer is refused by scope", async () => {
    expect((await post(user(ALICE, "viewer"))).status).toBe(403);
    expect(cr().status).toBe("approved");
  });

  it("a token with no recorded owner is refused (403 no_principal)", async () => {
    const token: Actor = {
      type: "token",
      id: "tok-1",
      tokenId: "tok-1",
      label: "ci-agent",
      workspaceId: WS,
      scopes: ["change:write"],
      principalId: null,
      channel: "api",
    } as Actor;
    const res = await post(token);
    expect([res.status, (await res.json()).code]).toEqual([403, "no_principal"]);
    expect(cr().status).toBe("approved");
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("a token owned by the requester may mark it, audited as a token with the owner as principal", async () => {
    const token: Actor = {
      type: "token",
      id: "tok-1",
      tokenId: "tok-1",
      label: "ci-agent",
      workspaceId: WS,
      scopes: ["change:write"],
      principalId: ALICE,
      channel: "api",
    } as Actor;
    const res = await post(token);
    expect(res.status).toBe(200);
    expect(cr()).toMatchObject({ implemented_by: null, implemented_by_type: "token", implemented_by_id: "tok-1" });
    expect(db.rows("audit_log")[0]).toMatchObject({ actor_type: "token", principal_id: ALICE, channel: "api" });
  });

  it("only an approved request: raised and rejected are 422 invalid_transition", async () => {
    for (const id of ["cr-2", "cr-3"]) {
      const res = await post(user(BOB, "manager"), undefined, id);
      expect([res.status, (await res.json()).code]).toEqual([422, "invalid_transition"]);
      expect(cr(id).implemented_at).toBeUndefined();
    }
    expect(db.rows("audit_log")).toHaveLength(0);
  });

  it("a repeat is refused (422 already_implemented) and never re-stamped", async () => {
    expect((await post(user(ALICE, "member"))).status).toBe(200);
    const stamped = cr().implemented_at;
    const again = await post(user(BOB, "manager"));
    expect([again.status, (await again.json()).code]).toEqual([422, "already_implemented"]);
    expect(cr().implemented_at).toBe(stamped);
    expect(db.rows("audit_log")).toHaveLength(1);
  });

  it("an unknown request is 404, and another workspace's request is invisible", async () => {
    expect((await post(user(BOB, "manager"), undefined, "nope")).status).toBe(404);
    const foreign: Actor = { ...user(BOB, "manager"), workspaceId: "ws-2" };
    expect((await post(foreign)).status).toBe(404);
    expect(cr().status).toBe("approved");
  });

  it("a note that is too long is a 422 validation error", async () => {
    const res = await post(user(ALICE, "member"), { note: "x".repeat(2_001) });
    expect(res.status).toBe(422);
    expect(cr().status).toBe("approved");
  });
});

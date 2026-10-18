/**
 * POST /api/rebaselines/:id/signoff — the vote, the status it implies and the
 * rebaseline.signoff audit row are ONE RPC (nopm_signoff_rebaseline, migration
 * 0063), so a vote never persists next to a status it contradicts and never
 * without its trail; D-16 (approvers only) is enforced in the route and in SQL.
 *
 * Harness as lifecycle-guards.test.ts: the real route (wrapped by route()) over
 * the in-memory admin client (RPC mirrored by test-support/fake-rpcs.ts);
 * requireAuth is mocked, requireScope is real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb, type Row } from "@/lib/governance/test-support/fake-admin";

const { holder, authHolder } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  authHolder: { actor: null as unknown },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (holder.db as FakeDb).client,
}));
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
vi.mock("@/lib/auth/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guard")>();
  return { ...actual, requireAuth: async () => authHolder.actor as Actor };
});

import { POST as signoff } from "./route";

const WS = "ws-1";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CASEY = "33333333-3333-4333-8333-333333333333";
const RB = "rb-pending";

function pat(id: string, owner: string): Actor {
  return {
    type: "token",
    id,
    tokenId: id,
    label: `${id}-agent`,
    workspaceId: WS,
    scopes: ["rebaseline:approve"],
    principalId: owner,
    principalRole: "manager",
    channel: "api",
    requestId: `req-${id}`,
  };
}
const bobPat = () => pat("tok-bob", BOB);

function call(actor: Actor, body: unknown) {
  authHolder.actor = actor;
  const req = new NextRequest(`http://localhost/api/rebaselines/${RB}/signoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return signoff(req, { params: Promise.resolve({ id: RB }) });
}

let db: FakeDb;
const rebaseline = () => db.rows("rebaselines").find((r) => r.id === RB) as Row;
const votes = () => db.rows("rebaseline_signoffs");
const audits = () => db.rows("audit_log").filter((r) => r.action === "rebaseline.signoff");

beforeEach(() => {
  db = new FakeDb({
    rebaselines: [
      { id: RB, workspace_id: WS, project_id: "proj-1", version: 1, status: "pending_approval", requested_by: null, requested_principal_id: ALICE },
    ],
    rebaseline_signoffs: [],
    profiles: [
      { id: ALICE, workspace_id: WS, role: "admin" },
      { id: BOB, workspace_id: WS, role: "manager" },
      { id: CASEY, workspace_id: WS, role: "member" },
    ],
    audit_log: [],
    notifications: [],
  });
  holder.db = db;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the vote and the status move together", () => {
  it("the non-racing path: the vote stands and the status follows it", async () => {
    const res = await call(bobPat(), { vote: "go" });
    expect(res.status).toBe(200);
    expect(votes().map((v) => v.vote)).toEqual(["go"]);
    expect(rebaseline().status).toBe("approved");
  });

  it("losing the race (the RPC finds the rebaseline already decided): 422, no vote row, no audit row", async () => {
    rebaseline().status = "approved"; // B's approval landed first
    const res = await call(bobPat(), { vote: "no_go", comment: "too risky" });
    expect(res.status).toBe(422);
    expect(rebaseline().status).toBe("approved");
    expect(votes()).toEqual([]);
    expect(audits()).toHaveLength(0);
  });

  it("a failure inside the RPC leaves no vote and no audit row", async () => {
    db.rpcHandlers.nopm_signoff_rebaseline = () => ({ data: null, error: { code: "XX000", message: "connection reset" } });
    const res = await call(bobPat(), { vote: "no_go", comment: "wrong dates" });
    expect(res.status).toBe(500);
    expect(votes()).toEqual([]);
    expect(rebaseline().status).toBe("pending_approval");
    expect(audits()).toHaveLength(0);
  });

  it("a no_go rejects the rebaseline", async () => {
    await call(bobPat(), { vote: "no_go", comment: "no" });
    expect(rebaseline().status).toBe("rejected");
  });
});

describe("D-16 — only admins and managers sign off", () => {
  const memberPat = () => ({ ...pat("tok-casey", CASEY), principalRole: "member" }) as Actor;

  it("a member's token is 403 role_not_permitted: nothing recorded, the RPC is not called", async () => {
    const res = await call(memberPat(), { vote: "go" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("role_not_permitted");
    expect(votes()).toEqual([]);
    expect(db.rpcCallsTo("nopm_signoff_rebaseline")).toHaveLength(0);
  });

  it("the RPC repeats the rule: a token that still claims manager but whose human was demoted is refused in SQL", async () => {
    db.rows("profiles").find((p) => p.id === BOB)!.role = "member";
    const res = await call(bobPat(), { vote: "go" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("role_not_permitted");
    expect(votes()).toEqual([]);
  });
});

describe("the rebaseline.signoff audit row records the vote, not just the rebaseline", () => {
  it("a first vote: signoff vote + comment, previous_vote null", async () => {
    await call(bobPat(), { vote: "go", comment: "dates agreed with the sponsor" });
    const [row] = audits();
    expect(row.before).toMatchObject({ id: RB, status: "pending_approval", signoff: null });
    expect(row.after).toMatchObject({
      id: RB,
      status: "approved",
      signoff: { approver_id: BOB, vote: "go", comment: "dates agreed with the sponsor", previous_vote: null },
    });
  });

  it("a changed vote keeps the previous one (vote, comment, time) in before.signoff", async () => {
    votes().push({ id: "sig-bob", workspace_id: WS, rebaseline_id: RB, approver_id: BOB, approver_principal_id: BOB, vote: "pending", voted_at: "2026-10-01T00:00:00.000Z", comment: "need the budget first" });
    await call(bobPat(), { vote: "go", comment: "budget confirmed" });
    const [row] = audits();
    expect(row.before).toMatchObject({
      signoff: { approver_id: BOB, vote: "pending", comment: "need the budget first", voted_at: "2026-10-01T00:00:00.000Z" },
    });
    expect(row.after).toMatchObject({
      signoff: { approver_id: BOB, vote: "go", comment: "budget confirmed", previous_vote: "pending" },
    });
    // Exactly one audit row per accepted vote.
    expect(audits()).toHaveLength(1);
  });
});

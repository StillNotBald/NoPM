/**
 * POST /api/rebaselines/:id/signoff — a vote never persists next to a status it
 * contradicts, and the audit row keeps the vote, its comment and the voter's
 * previous vote.
 *
 * Harness as lifecycle-guards.test.ts: the real route (wrapped by route()) over
 * the in-memory admin client; requireAuth is mocked, requireScope is real. A
 * concurrent writer is simulated with FakeDb.afterNextSelect.
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
    audit_log: [],
    notifications: [],
  });
  holder.db = db;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** Another voter's vote and decision land between this request's votes read and its status write. */
function concurrentDecision(status: "approved" | "rejected", otherVote: "go" | "no_go") {
  // select #1 is the previous-vote read; select #2 is the all-votes read the status is computed from.
  db.afterNextSelect("rebaseline_signoffs", () => {});
  db.afterNextSelect("rebaseline_signoffs", (d) => {
    d.rows("rebaseline_signoffs").push({
      id: "sig-other",
      workspace_id: WS,
      rebaseline_id: RB,
      approver_id: "99999999-9999-4999-8999-999999999999",
      vote: otherVote,
    });
    d.rows("rebaselines").find((r) => r.id === RB)!.status = status;
  });
}

describe("a losing vote does not persist next to the status that beat it", () => {
  it("A's no_go loses the status race to B's approval: 422, A's no_go row is gone, the rebaseline stays approved", async () => {
    concurrentDecision("approved", "go");
    const res = await call(bobPat(), { vote: "no_go", comment: "too risky" });
    expect(res.status).toBe(422);

    expect(rebaseline().status).toBe("approved");
    expect(votes().filter((v) => v.vote === "no_go")).toEqual([]);
    expect(votes().map((v) => v.id)).toEqual(["sig-other"]);
    expect(audits()).toHaveLength(0);
  });

  it("the loser who had voted before gets the previous vote back, not a deleted row", async () => {
    votes().push({ id: "sig-bob", workspace_id: WS, rebaseline_id: RB, approver_id: BOB, approver_principal_id: BOB, vote: "pending", voted_at: "2026-10-01T00:00:00.000Z", comment: "waiting on QA" });
    concurrentDecision("rejected", "no_go");
    const res = await call(bobPat(), { vote: "go" });
    expect(res.status).toBe(422);

    const mine = votes().filter((v) => v.approver_id === BOB);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ vote: "pending", comment: "waiting on QA", voted_at: "2026-10-01T00:00:00.000Z" });
    expect(rebaseline().status).toBe("rejected");
  });

  it("a database error on the status write also takes the vote back out", async () => {
    const realFrom = db.client.from;
    db.client.from = (table: string) => {
      const b = realFrom(table) as unknown as { update: (p: Row) => unknown };
      if (table === "rebaselines") {
        b.update = () => {
          const result = { data: null, error: { code: "XX000", message: "connection reset" } };
          const chain: unknown = new Proxy(
            {},
            {
              get: (_t, prop) => {
                if (prop === "then") return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
                if (prop === "single" || prop === "maybeSingle") return () => Promise.resolve(result);
                return () => chain;
              },
            },
          );
          return chain;
        };
      }
      return b as never;
    };
    const res = await call(bobPat(), { vote: "no_go" });
    expect(res.status).toBe(500);
    expect(votes()).toEqual([]);
    expect(rebaseline().status).toBe("pending_approval");
    expect(audits()).toHaveLength(0);
  });

  it("the non-racing path is unchanged: the vote stands and the status follows it", async () => {
    const res = await call(bobPat(), { vote: "go" });
    expect(res.status).toBe(200);
    expect(votes().map((v) => v.vote)).toEqual(["go"]);
    expect(rebaseline().status).toBe("approved");
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

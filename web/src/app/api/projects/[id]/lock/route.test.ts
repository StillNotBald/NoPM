/**
 * Lock / unlock rules (Q-GOV-9, Q-GOV-10): locking twice changes nothing and keeps
 * the first who/when/why; lock needs a manager/admin (or a write token); unlock
 * needs a manager/admin in person and never a token.
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

import { POST as lock } from "./route";
import { POST as unlock } from "../unlock/route";

const WS = "ws-1";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const P1 = "44444444-4444-4444-8444-444444444444";

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
const token = (scopes: string[]): Actor => ({
  type: "token",
  id: "tok-1",
  tokenId: "tok-1",
  label: "agent",
  workspaceId: WS,
  scopes,
  principalId: BOB,
  principalRole: "manager",
  channel: "api",
  requestId: "req-tok",
});

let db: FakeDb;
const project = () => db.rows("projects")[0];
function post(handler: typeof lock, actor: Actor, body: unknown = {}) {
  authHolder.actor = actor;
  return handler(
    new NextRequest(`http://localhost/api/projects/${P1}/x`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: P1 }) },
  );
}

beforeEach(() => {
  db = new FakeDb({
    projects: [{ id: P1, workspace_id: WS, name: "Billing", is_locked: false, start_date: "2027-01-01", target_date: "2027-06-30" }],
    rebaselines: [],
    profiles: [
      { id: ALICE, workspace_id: WS, role: "admin" },
      { id: BOB, workspace_id: WS, role: "manager" },
    ],
    audit_log: [],
  });
  holder.db = db;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("Q-GOV-9 — locking an already locked project", () => {
  it("the second lock does nothing: first who/when/why kept, no second audit row, already_locked = true", async () => {
    const first = await post(lock, user(ALICE, "admin"), { reason: "Q3 freeze" });
    expect(first.status).toBe(200);
    const lockedAt = project().locked_at;
    const second = await post(lock, user(BOB, "manager"), { reason: "something else" });
    expect(second.status).toBe(200);
    expect((await second.json()).data.already_locked).toBe(true);
    expect(project()).toMatchObject({ locked_by: ALICE, locked_at: lockedAt, lock_reason: "Q3 freeze" });
    expect(db.rows("audit_log").filter((a) => a.action === "project.lock")).toHaveLength(1);
  });
});

describe("M7 / K3 — a lock always records who locked it", () => {
  it("a person lock records the user as locked_by and as the actor", async () => {
    await post(lock, user(ALICE, "admin"), { reason: "freeze" });
    expect(project()).toMatchObject({
      is_locked: true,
      locked_by: ALICE,
      locked_by_actor_type: "user",
      locked_by_actor_id: ALICE,
    });
    expect(project().locked_at).toBeTruthy();
    expect(project().locked_by_label).toBeTruthy();
  });

  it("a token lock keeps locked_by = the token's owner and always sets the actor columns", async () => {
    db.rows("api_tokens").push({ id: "tok-1", workspace_id: WS, created_by: BOB });
    await post(lock, token(["project:write"]), { reason: "agent freeze" });
    expect(project()).toMatchObject({
      is_locked: true,
      locked_by: BOB,
      locked_by_actor_type: "token",
      locked_by_actor_id: "tok-1",
      locked_by_label: "agent",
    });
    expect(project().locked_at).toBeTruthy();
  });

  it("a token with no recorded owner still leaves locked_by_actor_id set (the CHECK keys on it)", async () => {
    await post(lock, token(["project:write"]));
    expect(project().locked_by).toBeNull();
    expect(project().locked_by_actor_id).toBe("tok-1");
  });

  it("unlock clears the locker columns", async () => {
    await post(lock, user(ALICE, "admin"));
    await post(unlock, user(BOB, "manager"), { reason: "fix dates" });
    expect(project()).toMatchObject({
      is_locked: false,
      locked_by: null,
      locked_by_actor_type: null,
      locked_by_actor_id: null,
      locked_by_label: null,
      locked_at: null,
    });
  });
});

describe("Q-GOV-10 — who may lock and unlock", () => {
  it("a manager and an admin lock; a member does not; a write token does", async () => {
    expect((await post(lock, user(BOB, "manager"))).status).toBe(200);
    project().is_locked = false;
    expect((await post(lock, user(ALICE, "admin"))).status).toBe(200);
    project().is_locked = false;
    const member = await post(lock, user(ALICE, "member"));
    expect([member.status, (await member.json()).error]).toEqual([403, "Only a manager or admin can lock a project."]);
    expect((await post(lock, token(["project:write"]))).status).toBe(200);
  });

  it("unlock: a manager or admin in person; a member and any token are refused with the plain message", async () => {
    project().is_locked = true;
    const member = await post(unlock, user(ALICE, "member"), { reason: "x" });
    expect([member.status, (await member.json()).error]).toEqual([
      403,
      "Only a manager or admin can unlock a project, in person.",
    ]);
    const agent = await post(unlock, token(["project:write", "rebaseline:approve"]), { reason: "x" });
    const agentBody = await agent.json();
    expect([agent.status, agentBody.code]).toEqual([403, "agents_cannot_unlock"]);
    expect(agentBody.error).toBe("Only a manager or admin can unlock a project, in person. Agents and API tokens cannot.");
    expect(project().is_locked).toBe(true);
    expect((await post(unlock, user(BOB, "manager"), { reason: "fix dates" })).status).toBe(200);
    expect(project().is_locked).toBe(false);
  });
});

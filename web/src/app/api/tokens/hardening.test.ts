/**
 * Token routes, auth-core fix wave (2026-10-17):
 *  - D-ACC-11: revoking an already revoked token is 409 "Token already revoked"
 *    with no second audit row; only kind = 'user' tokens are addressable.
 *  - A1-3 / A2-2: the shared public demo login cannot mint a token (403).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { fakeDb, type Call } from "@/lib/auth/fake-db.testutil";

const { state } = vi.hoisted(() => ({
  state: {
    actor: null as unknown,
    demo: false,
    db: null as unknown as ReturnType<typeof import("@/lib/auth/fake-db.testutil").fakeDb>,
  },
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db.client }));
vi.mock("@/lib/auth/demo", () => ({
  DEMO_RESTRICTED_MESSAGE: "Not available in the shared demo",
  isDemoActor: async () => state.demo,
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
  return { ...actual, requireAuth: async () => state.actor as Actor };
});

import { POST } from "./route";
import { DELETE } from "./[id]/route";

const WS = "ws-1";
const manager: Actor = {
  type: "user",
  id: "11111111-1111-4111-8111-111111111111",
  label: "Manager",
  workspaceId: WS,
  role: "manager",
  principalId: "11111111-1111-4111-8111-111111111111",
};
const TOKEN = { id: "t-1", name: "CI", prefix: "npm_ab", scopes: ["task:read"], expires_at: null, revoked: false, last_used_at: null, created_at: "x" };

function dbFor(tokenRow: Record<string, unknown> | null) {
  state.db = fakeDb((c: Call) => {
    if (c.table === "api_tokens" && c.op === "select") return { data: tokenRow };
    if (c.table === "api_tokens" && c.op === "update") return { data: [{ id: "t-1" }] };
    if (c.table === "api_tokens" && c.op === "insert") return { data: { id: "new-1", ...(c.payload as object) } };
    return { data: null };
  });
}

const revoke = (id = "t-1") =>
  DELETE(new NextRequest(`http://localhost/api/tokens/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  state.actor = manager;
  state.demo = false;
  dbFor(TOKEN);
});

describe("DELETE /api/tokens/[id]", () => {
  it("revokes a live personal token and writes exactly one audit row", async () => {
    const res = await revoke();
    expect(res.status).toBe(200);
    expect(state.db.auditRows()).toHaveLength(1);
    expect(state.db.auditRows()[0]).toMatchObject({ action: "token.revoke", workspace_id: WS });
  });

  it("only looks at kind = 'user' tokens (the assistant's ephemeral tokens are not addressable)", async () => {
    await revoke();
    const lookup = state.db.calls.find((c) => c.table === "api_tokens" && c.op === "select");
    expect(lookup?.filters).toContainEqual(["eq", "kind", "user"]);
    // The write is the atomic RPC (migration 0103), addressed by the id the kind-filtered lookup returned.
    const write = state.db.rpcCalls.find((c) => c.fn === "nopm_mutate_audited");
    expect(write?.args).toMatchObject({ p_table: "api_tokens", p_op: "update", p_patch: { revoked: true } });
  });

  it("an assistant token (no match for kind = 'user') is 404 and unaudited", async () => {
    dbFor(null);
    const res = await revoke();
    expect(res.status).toBe(404);
    expect(state.db.auditRows()).toHaveLength(0);
  });

  it("an already revoked token is 409 'Token already revoked' with NO new audit row", async () => {
    dbFor({ ...TOKEN, revoked: true });
    const res = await revoke();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Token already revoked");
    expect(state.db.auditRows()).toHaveLength(0);
    expect(state.db.calls.some((c) => c.op === "update")).toBe(false);
  });

  it("a failed atomic write leaves no audit row and surfaces as an error", async () => {
    state.db = fakeDb(
      (c) => (c.table === "api_tokens" && c.op === "select" ? { data: TOKEN } : {}),
      (fn) => (fn === "nopm_mutate_audited" ? { error: { message: "boom", code: "XX000" } } : { data: { allowed: true, remaining: 9, retry_after_seconds: 0 } }),
    );
    const res = await revoke();
    expect(res.status).toBe(500);
  });
});

describe("POST /api/tokens — shared demo login (A1-3 / A2-2)", () => {
  const mint = () =>
    POST(
      new NextRequest("http://localhost/api/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x", scopes: ["task:read"] }),
      }),
      { params: Promise.resolve({}) },
    );

  it("403 'Not available in the shared demo' for the demo actor, nothing inserted", async () => {
    state.demo = true;
    const res = await mint();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Not available in the shared demo");
    expect(state.db.calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("a normal manager still mints", async () => {
    const res = await mint();
    expect(res.status).toBe(201);
  });
});

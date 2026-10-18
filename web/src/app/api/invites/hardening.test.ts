/**
 * POST /api/invites, auth-core fix wave (2026-10-17):
 *  - A1-3 / A2-2: the shared public demo login cannot mint an invite (403).
 *  - D-ACC-15: inviting an e-mail that already has an account in this workspace is 409.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { fakeDb, type Call } from "@/lib/auth/fake-db.testutil";

const { state } = vi.hoisted(() => ({
  state: {
    actor: null as unknown,
    demo: false,
    account: null as unknown,
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

const manager: Actor = { type: "user", id: "u-1", label: "M", workspaceId: "ws-1", role: "manager", principalId: "u-1" };

const invite = (email = "New.Person@example.com") =>
  POST(
    new NextRequest("http://localhost/api/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, role: "member" }),
    }),
    { params: Promise.resolve({}) },
  );

beforeEach(() => {
  state.actor = manager;
  state.demo = false;
  state.account = null;
  state.db = fakeDb((c: Call) => {
    if (c.table === "profiles") return { data: state.account };
    if (c.table === "invites" && c.op === "select") return { data: null };
    if (c.table === "invites" && c.op === "insert") {
      return { data: { id: "inv-1", email: "x", role: "member", revoked: false, accepted_at: null, expires_at: new Date(Date.now() + 1e9).toISOString() } };
    }
    return {};
  });
});

describe("POST /api/invites", () => {
  it("403 'Not available in the shared demo' for the demo actor, nothing inserted", async () => {
    state.demo = true;
    const res = await invite();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Not available in the shared demo");
    expect(state.db.calls.some((c) => c.table === "invites" && c.op === "insert")).toBe(false);
  });

  it("409 'This email already has an account…' when a profile with that e-mail exists in this workspace", async () => {
    state.account = { id: "p-9" };
    const res = await invite();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This email already has an account. Ask them to sign in instead.");
    expect(state.db.calls.some((c) => c.table === "invites" && c.op === "insert")).toBe(false);
    expect(state.db.auditRows()).toHaveLength(0);
  });

  it("checks the account inside the caller's workspace, case-insensitively with wildcards escaped", async () => {
    await invite("a_b+c@example.com");
    const lookup = state.db.calls.find((c) => c.table === "profiles");
    expect(lookup?.filters).toContainEqual(["eq", "workspace_id", "ws-1"]);
    expect(lookup?.filters).toContainEqual(["ilike", "email", "a\\_b+c@example.com"]);
  });

  it("an unknown e-mail is invited normally (201, one audit row)", async () => {
    const res = await invite();
    expect(res.status).toBe(201);
    expect(state.db.auditRows()).toHaveLength(1);
  });
});

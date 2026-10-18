import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ account: null as unknown, updated: false }));

vi.mock("@/lib/auth/guard", () => ({
  requireAuth: async () => ({ type: "user", id: "a1", label: "A", workspaceId: "ws1", role: "admin", principalId: "a1" }),
}));
vi.mock("@/lib/audit/write", () => ({ writeAudit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      // Atomic update + audit (migration 0103).
      if (fn === "nopm_mutate_audited") {
        h.updated = true;
        return { data: { before: { id: "inv1" }, after: { id: "inv1", revoked: false, accepted_at: null, ...(args.p_patch as object) } }, error: null };
      }
      return { data: { allowed: true, retry_after_seconds: 0 }, error: null };
    },
    from: (t: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "limit", "ilike"]) b[m] = () => b;
      b.update = () => {
        h.updated = true;
        return b;
      };
      b.single = async () => ({ data: { id: "inv1", expires_at: new Date(Date.now() + 1e9).toISOString(), revoked: false, accepted_at: null }, error: null });
      b.maybeSingle = async () =>
        t === "invites"
          ? { data: { id: "inv1", revoked: false, accepted_at: null, expires_at: new Date(Date.now() - 1000).toISOString(), email: "e@x.com", role: "member", created_by: null }, error: null }
          : { data: h.account, error: null };
      return b;
    },
  }),
}));

import { POST } from "./route";

const call = () =>
  POST(new NextRequest("http://localhost/api/invites/inv1/renew", { method: "POST" }), {
    params: Promise.resolve({ id: "inv1" }),
  });

beforeEach(() => {
  h.account = null;
  h.updated = false;
});

describe("POST /api/invites/:id/renew account guard (R3-2)", () => {
  it("refuses 422 account_exists when the email already has an account (active or removed)", async () => {
    h.account = { id: "p9" };
    const res = await call();
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("account_exists");
    expect(h.updated).toBe(false);
  });
  it("renews when no account exists", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(h.updated).toBe(true);
  });
});

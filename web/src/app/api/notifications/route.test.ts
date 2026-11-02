import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const h = vi.hoisted(() => ({
  actor: null as unknown as Actor,
  eqs: [] as Array<[string, unknown]>,
}));

vi.mock("@/lib/auth/guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/guard")>()),
  requireAuth: vi.fn(async () => h.actor),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: { allowed: true }, error: null }),
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => (h.eqs.push([c, v]), b);
      b.is = () => b;
      b.order = () => b;
      b.range = async () => ({ data: [{ id: "n1" }], error: null, count: 1 });
      return b;
    },
  }),
}));

import { GET } from "./route";

const call = () => GET(new NextRequest("http://localhost/api/notifications?unread=1"), { params: Promise.resolve({}) });

const PERSON = "11111111-1111-4111-8111-111111111111";
const TOKEN_ID = "99999999-9999-4999-8999-999999999999";

beforeEach(() => {
  h.eqs.length = 0;
});

describe("GET /api/notifications (R-187)", () => {
  it("a session user gets their own notifications, workspace-scoped", async () => {
    h.actor = { type: "user", id: PERSON, label: "u", workspaceId: "w1", role: "member", principalId: PERSON, scopes: ["notification:read"] };
    const res = await call();
    expect(res.status).toBe(200);
    expect(h.eqs).toContainEqual(["workspace_id", "w1"]);
    expect(h.eqs).toContainEqual(["recipient_id", PERSON]);
  });

  it("a token caller gets the person behind the token, never the token id", async () => {
    h.actor = { type: "token", id: TOKEN_ID, tokenId: TOKEN_ID, label: "t", workspaceId: "w1", principalId: PERSON, scopes: ["notification:read"] };
    const res = await call();
    expect(res.status).toBe(200);
    expect(h.eqs).toContainEqual(["recipient_id", PERSON]);
    expect(h.eqs).not.toContainEqual(["recipient_id", TOKEN_ID]);
    expect(h.eqs).toContainEqual(["workspace_id", "w1"]);
  });

  it("a legacy token with no known person gets an empty page and no query", async () => {
    h.actor = { type: "token", id: TOKEN_ID, tokenId: TOKEN_ID, label: "t", workspaceId: "w1", principalId: null, scopes: ["notification:read"] };
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
    expect(h.eqs).toHaveLength(0);
  });

  it("still needs the notification:read scope", async () => {
    h.actor = { type: "token", id: TOKEN_ID, tokenId: TOKEN_ID, label: "t", workspaceId: "w1", principalId: PERSON, scopes: ["task:read"] };
    const res = await call();
    expect(res.status).toBe(403);
  });
});

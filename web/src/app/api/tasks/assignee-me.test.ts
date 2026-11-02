import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const h = vi.hoisted(() => ({
  actor: null as unknown as Actor,
  member: null as { id: string } | null,
  taskEqs: [] as Array<[string, unknown]>,
  memberEqs: [] as Array<[string, unknown]>,
}));

vi.mock("@/lib/auth/guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/guard")>()),
  requireAuth: vi.fn(async () => h.actor),
}));
vi.mock("@/lib/integrations/time-zone", () => ({ workspaceToday: async () => "2026-11-03" }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: { allowed: true }, error: null }),
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      const log = table === "resource_members" ? h.memberEqs : h.taskEqs;
      for (const m of ["select", "lte", "gte", "lt", "not", "ilike", "order"]) b[m] = () => b;
      b.eq = (c: string, v: unknown) => (log.push([c, v]), b);
      b.maybeSingle = async () => ({ data: h.member, error: null });
      b.range = async () => ({ data: [{ id: "t1" }], error: null, count: 1 });
      return b;
    },
  }),
}));

import { GET } from "./route";

const call = (qs: string) => GET(new NextRequest(`http://localhost/api/tasks?${qs}`), { params: Promise.resolve({}) });

const PERSON = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  h.taskEqs.length = 0;
  h.memberEqs.length = 0;
  h.member = { id: MEMBER };
  h.actor = { type: "token", id: "tok", tokenId: "tok", label: "t", workspaceId: "w1", principalId: PERSON, scopes: ["task:read"] };
});

describe("GET /api/tasks?assignee_id=me (R-187)", () => {
  it("resolves me to the caller's resource member in this workspace and filters on it", async () => {
    const res = await call("assignee_id=me&overdue=true");
    expect(res.status).toBe(200);
    expect(h.memberEqs).toContainEqual(["workspace_id", "w1"]);
    expect(h.memberEqs).toContainEqual(["profile_id", PERSON]);
    expect(h.taskEqs).toContainEqual(["assignee_id", MEMBER]);
    expect(h.taskEqs).toContainEqual(["workspace_id", "w1"]);
  });

  it("a person with no member row gets an empty page, not every task", async () => {
    h.member = null;
    const res = await call("assignee_id=me");
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
    expect(h.taskEqs).toHaveLength(0);
  });

  it("a legacy token with no person gets an empty page", async () => {
    h.actor = { ...h.actor, principalId: null } as Actor;
    const body = await (await call("assignee_id=me")).json();
    expect(body.data).toEqual([]);
    expect(h.memberEqs).toHaveLength(0);
  });

  it("an explicit member id is passed through unchanged", async () => {
    await call(`assignee_id=${MEMBER}`);
    expect(h.taskEqs).toContainEqual(["assignee_id", MEMBER]);
    expect(h.memberEqs).toHaveLength(0);
  });
});

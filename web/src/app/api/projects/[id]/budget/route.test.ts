import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const h = vi.hoisted(() => ({
  locked: true,
  cr: null as Record<string, unknown> | null,
  upserts: [] as Record<string, unknown>[],
  crUpdates: [] as Record<string, unknown>[],
  claimable: true,
  upsertFails: false,
}));
vi.mock("@/lib/audit/write", () => ({ writeAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/insight/overspend", async (orig) => ({
  ...(await orig<typeof import("@/lib/insight/overspend")>()),
  recordOverspendCrossing: vi.fn(async () => "ok"),
}));
vi.mock("@/lib/auth/guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/guard")>()),
  requireAuth: vi.fn(async (): Promise<Actor> => ({
    type: "user", id: "u", label: "u", workspaceId: "w", role: "manager", principalId: "u",
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: { allowed: true }, error: null }),
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is"]) b[m] = () => b;
      b.update = (patch: Record<string, unknown>) => {
        h.crUpdates.push(patch);
        const u: Record<string, unknown> = {};
        u.eq = () => u;
        u.is = () => u;
        u.select = async () => ({ data: h.claimable ? [{ id: "x" }] : [] });
        return u;
      };
      b.upsert = (row: Record<string, unknown>) => {
        h.upserts.push(row);
        return {
          select: () => ({
            single: async () =>
              h.upsertFails ? { data: null, error: { message: "boom" } } : { data: row, error: null },
          }),
        };
      };
      b.maybeSingle = async () => ({
        data:
          table === "projects"
            ? { id: "p", is_locked: h.locked }
            : table === "change_requests"
              ? h.cr
              : null,
      });
      return b;
    },
  }),
}));

import { PUT, PATCH } from "./route";

const CR = "11111111-1111-4111-8111-111111111111";
const call = (fn: typeof PUT, body: unknown) =>
  fn(
    new NextRequest("http://localhost/api/projects/p/budget", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "p" }) },
  );

beforeEach(() => {
  h.locked = true;
  h.cr = null;
  h.upserts.length = 0;
  h.crUpdates.length = 0;
  h.claimable = true;
  h.upsertFails = false;
});

describe("budget change on a locked project (decision 23)", () => {
  it("422s without a change request id", async () => {
    const res = await call(PUT, { planned_amount: 100 });
    expect(res.status).toBe(422);
    expect(h.upserts).toHaveLength(0);
  });
  it("422s for a change request that is not approved", async () => {
    h.cr = { id: CR, status: "raised", project_id: "p", category: "cost" };
    const res = await call(PATCH, { planned_amount: 100, change_request_id: CR });
    expect(res.status).toBe(422);
    expect(h.upserts).toHaveLength(0);
  });
  it("422s for a change request of another project", async () => {
    h.cr = { id: CR, status: "approved", project_id: "other", category: "cost" };
    expect((await call(PUT, { planned_amount: 100, change_request_id: CR })).status).toBe(422);
  });
  it("accepts an approved change request of this project", async () => {
    h.cr = { id: CR, status: "approved", project_id: "p", category: "cost" };
    const res = await call(PUT, { planned_amount: 100, change_request_id: CR });
    expect(res.status).toBe(200);
    expect(h.upserts).toHaveLength(1);
    expect("change_request_id" in h.upserts[0]).toBe(false);
  });
  it("422s for a change request that is not about cost", async () => {
    h.cr = { id: CR, status: "approved", project_id: "p", category: "scope", impact_cost: null };
    const res = await call(PUT, { planned_amount: 100, change_request_id: CR });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("change_request_not_cost");
    expect(h.upserts).toHaveLength(0);
  });
  it("accepts a non-cost-category request that states a cost impact", async () => {
    h.cr = { id: CR, status: "approved", project_id: "p", category: "scope", impact_cost: 500 };
    expect((await call(PUT, { planned_amount: 100, change_request_id: CR })).status).toBe(200);
  });
  it("consumes the change request on use, and a request already used is refused (R3-9)", async () => {
    h.cr = { id: CR, status: "approved", project_id: "p", category: "cost" };
    expect((await call(PUT, { planned_amount: 100, change_request_id: CR })).status).toBe(200);
    expect(h.crUpdates[0]).toMatchObject({ budget_consumed_by: "p" });
    expect(typeof h.crUpdates[0].budget_consumed_at).toBe("string");
    h.claimable = false;
    h.upserts.length = 0;
    const res = await call(PUT, { planned_amount: 200, change_request_id: CR });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("change_request_used");
    expect(h.upserts).toHaveLength(0);
  });
  it("gives the change request back when the budget write fails", async () => {
    h.cr = { id: CR, status: "approved", project_id: "p", category: "cost" };
    h.upsertFails = true;
    expect((await call(PUT, { planned_amount: 100, change_request_id: CR })).status).toBe(500);
    expect(h.crUpdates.at(-1)).toEqual({ budget_consumed_at: null, budget_consumed_by: null });
  });
  it("changing only the warning threshold needs no change request", async () => {
    expect((await call(PATCH, { overspend_warn_pct: 80 })).status).toBe(200);
    expect(h.crUpdates).toHaveLength(0);
  });
  it("needs no change request while the dates are not locked", async () => {
    h.locked = false;
    expect((await call(PUT, { planned_amount: 100 })).status).toBe(200);
  });
});

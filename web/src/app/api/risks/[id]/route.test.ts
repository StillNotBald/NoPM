import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const h = vi.hoisted(() => ({
  updates: [] as Record<string, unknown>[],
  notify: vi.fn(async () => {}),
}));
const EXISTING = {
  id: "r1", workspace_id: "w", project_id: "p1", title: "Vendor slip", description: "d",
  reference_id: "R-1", severity: "low", updated_at: "2026-10-01T00:00:00Z",
};
vi.mock("@/lib/audit/write", () => ({ writeAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/notify/publish", () => ({
  notify: h.notify,
  resolveProjectOwner: vi.fn(async () => "owner-1"),
}));
vi.mock("@/lib/auth/guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/guard")>()),
  requireAuth: vi.fn(async (): Promise<Actor> => ({
    type: "user", id: "u", label: "u", workspaceId: "w", role: "manager", principalId: "u",
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    // nopm_mutate_audited (migration 0103): the write and its audit row; the patch is what was written.
    rpc: async (name: string, a: { p_patch?: Record<string, unknown> }) => {
      if (name !== "nopm_mutate_audited") return { data: { allowed: true }, error: null };
      h.updates.push(a.p_patch as Record<string, unknown>);
      return { data: { before: EXISTING, after: { ...EXISTING, ...a.p_patch } }, error: null };
    },
    from: () => {
      let isUpdate = false;
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) b[m] = () => b;
      b.update = (u: Record<string, unknown>) => {
        isUpdate = true;
        h.updates.push(u);
        return b;
      };
      b.maybeSingle = async () => ({
        data: isUpdate ? { ...EXISTING, ...h.updates[h.updates.length - 1] } : EXISTING,
        error: null,
      });
      return b;
    },
  }),
}));

import { PATCH } from "./route";

const patch = (body: unknown) =>
  PATCH(
    new NextRequest("http://localhost/api/risks/r1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "r1" }) },
  );
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.updates.length = 0;
  h.notify.mockClear();
});

describe("PATCH /api/risks/:id", () => {
  it("saves every enrichment field the schema accepts", async () => {
    const res = await patch({
      probability_pct: 40, impact_score: 4, impact_area: "cost", risk_category: "scope_requirements",
      response_strategy: "avoid", trigger: "PO late", residual_risk: "low",
    });
    expect(res.status).toBe(200);
    expect(h.updates[0]).toMatchObject({
      probability_pct: 40, impact_score: 4, impact_area: "cost", risk_category: "scope_requirements",
      response_strategy: "avoid", trigger: "PO late", residual_risk: "low",
    });
  });

  it("fires the high/critical alert when severity is raised", async () => {
    await patch({ severity: "critical" });
    await flush();
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("does not alert for a lower severity or an unchanged one", async () => {
    await patch({ severity: "low" });
    await patch({ title: "x" });
    await flush();
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/risks/:id - K1 / K2", () => {
  it("refuses the retired free-text category (422), writing nothing", async () => {
    const res = await patch({ category: "Technical" });
    expect(res.status).toBe(422);
    expect(h.updates).toEqual([]);
  });

  it("impact_areas is saved as the array, with impact_area mirroring its first element", async () => {
    const res = await patch({ impact_areas: ["cost", "schedule", "cost"] });
    expect(res.status).toBe(200);
    expect(h.updates[0]).toMatchObject({ impact_areas: ["cost", "schedule"], impact_area: "cost" });
  });

  it("the impact_area shorthand writes a one-element array; null clears both", async () => {
    await patch({ impact_area: "quality" });
    await patch({ impact_area: null });
    expect(h.updates[0]).toMatchObject({ impact_areas: ["quality"], impact_area: "quality" });
    expect(h.updates[1]).toMatchObject({ impact_areas: [], impact_area: null });
  });

  it("leaves impact areas alone when neither is sent", async () => {
    await patch({ title: "x" });
    expect(h.updates[0]).not.toHaveProperty("impact_areas");
    expect(h.updates[0]).not.toHaveProperty("impact_area");
  });
});

describe("DELETE /api/risks/:id scope (W1-06)", () => {
  it("requires risk:delete, which risk:write alone does not grant", async () => {
    const { hasScope } = await import("@/lib/auth/tokens");
    expect(hasScope(["risk:write"], "risk:delete")).toBe(false);
    expect(hasScope(["risk:*"], "risk:delete")).toBe(true);
  });
});

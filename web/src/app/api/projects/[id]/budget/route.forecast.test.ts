import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

// B3: the forecast inputs on the budget route. The project is LOCKED throughout, to show that the
// to-finish estimate and the forecast method are advisory (no change request) while money is not.
const h = vi.hoisted(() => ({
  budget: null as Record<string, unknown> | null,
  upserts: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/insight/overspend", async (orig) => ({
  ...(await orig<typeof import("@/lib/insight/overspend")>()),
  recordOverspendCrossing: vi.fn(async () => "ok"),
}));
vi.mock("@/lib/integrations/time-zone", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/time-zone")>()),
  workspaceToday: async () => "2026-10-18",
}));
vi.mock("@/lib/auth/guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/guard")>()),
  requireAuth: vi.fn(
    async (): Promise<Actor> => ({ type: "user", id: "u", label: "u", workspaceId: "w", role: "manager", principalId: "u" }),
  ),
}));
vi.mock("@/lib/api/rate-limit", () => ({ checkRateLimit: async () => undefined }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    // Atomic budget write + audit (migration 0103): the patch is what was saved, the audit half is recorded alongside.
    rpc: async (fn: string, args: { p_id?: string; p_patch?: Record<string, unknown>; p_audit?: { action: string } }) => {
      if (fn !== "nopm_mutate_audited") return { data: { allowed: true, remaining: 99, retry_after_seconds: 0 }, error: null };
      h.upserts.push(args.p_patch ?? {});
      h.audits.push({ action: args.p_audit?.action, targetId: args.p_id, after: args.p_patch });
      return { data: { before: h.budget, after: { ...(h.budget ?? {}), ...(args.p_patch ?? {}) } }, error: null };
    },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "order", "limit"]) b[m] = () => b;
      b.maybeSingle = async () => ({
        data:
          table === "projects"
            ? { id: "p", is_locked: true, completion_pct: 50, baseline_start_date: null, baseline_target_date: null }
            : table === "project_budget"
              ? h.budget
              : null,
        error: null,
      });
      b.then = (res: (v: unknown) => unknown) =>
        res({ data: table === "expenses" ? [{ amount: 60_000 }] : [], error: null });
      return b;
    },
  }),
}));

import { GET, PATCH, PUT } from "./route";

const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/api/projects/p/budget", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = { params: Promise.resolve({ id: "p" }) };

beforeEach(() => {
  h.budget = {
    project_id: "p",
    planned_amount: 100_000,
    committed_amount: 10_000,
    currency: "USD",
    estimate_to_complete: 25_000,
    forecast_method: "bottom_up",
  };
  h.upserts.length = 0;
  h.audits.length = 0;
});

describe("PATCH /api/projects/:id/budget forecast fields", () => {
  it("saves the to-finish estimate and the method on a locked project with no change request, and audits it", async () => {
    const res = await PATCH(req("PATCH", { estimate_to_complete: 30_000, forecast_method: "bottom_up" }), params);
    expect(res.status).toBe(200);
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0]).toMatchObject({ estimate_to_complete: 30_000, forecast_method: "bottom_up" });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ action: "budget.update", targetId: "p" });
    expect((h.audits[0].after as Record<string, unknown>).estimate_to_complete).toBe(30_000);
  });

  it("null clears the estimate", async () => {
    const res = await PATCH(req("PATCH", { estimate_to_complete: null }), params);
    expect(res.status).toBe(200);
    expect(h.upserts[0]).toMatchObject({ estimate_to_complete: null });
  });

  it("still demands a change request for a money change on a locked project", async () => {
    const res = await PATCH(req("PATCH", { planned_amount: 1, estimate_to_complete: 5 }), params);
    expect(res.status).toBe(422);
    expect(h.upserts).toHaveLength(0);
  });

  it.each([
    [{ forecast_method: "magic" }],
    [{ estimate_to_complete: -1 }],
    [{ estimate_to_complete: "lots" }],
  ])("422s %j", async (body) => {
    expect((await PATCH(req("PATCH", body), params)).status).toBe(422);
    expect(h.upserts).toHaveLength(0);
  });

  it("PUT accepts the same fields", async () => {
    const res = await PUT(req("PUT", { planned_amount: 100, forecast_method: "cpi", estimate_to_complete: 1 }), params);
    // locked project: PUT carries planned_amount, so it needs a change request (money), not the forecast fields
    expect(res.status).toBe(422);
  });
});

describe("GET /api/projects/:id/budget forecast", () => {
  it("returns both forecasts, the method and the committed amount kept apart from actual", async () => {
    const res = await GET(req("GET"), params);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.actual).toBe(60_000);
    expect(data.forecast).toMatchObject({
      method: "bottom_up",
      estimate_to_complete: 25_000,
      committed: 10_000,
      eac_bottom_up: 95_000,
      eac: 95_000,
    });
    expect(data.forecast.eac_cpi).toBeCloseTo(120_000, 0);
    expect(data.forecast.etc).toBe(35_000);
  });

  it("reports a null bottom-up forecast while no estimate exists", async () => {
    h.budget = { ...h.budget!, estimate_to_complete: null };
    const { data } = await (await GET(req("GET"), params)).json();
    expect(data.forecast.eac_bottom_up).toBeNull();
    expect(data.forecast.eac).toBeNull(); // method is bottom_up: no silent fallback to cpi
    expect(data.forecast.eac_cpi).not.toBeNull();
  });
});

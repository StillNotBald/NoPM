/**
 * New read routes for decision prep (B7, R-139): GET /api/change-requests,
 * GET /api/decisions, GET /api/projects/:id/evm. Workspace filter, scope gate,
 * paging and filters, EVM numbers match computeEvm.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

type Call = { table: string; select?: string; eq: [string, unknown][]; range?: [number, number] };
const h = vi.hoisted(() => ({
  actor: null as unknown,
  calls: [] as Call[],
  rows: {} as Record<string, unknown[]>,
  single: {} as Record<string, unknown>,
}));

vi.mock("@/lib/auth/guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/guard")>()),
  requireAuth: vi.fn(async () => h.actor as Actor),
}));
vi.mock("@/lib/api/rate-limit", () => ({ checkRateLimit: vi.fn(async () => {}) }));
vi.mock("@/lib/integrations/time-zone", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/time-zone")>()),
  workspaceToday: vi.fn(async () => "2026-06-01"),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const call: Call = { table, eq: [] };
      h.calls.push(call);
      const b: Record<string, unknown> = {};
      b.select = (s: string) => { call.select = s; return b; };
      b.eq = (c: string, v: unknown) => { call.eq.push([c, v]); return b; };
      b.order = () => b;
      b.range = async (a: number, z: number) => {
        call.range = [a, z];
        return { data: h.rows[table] ?? [], error: null, count: (h.rows[table] ?? []).length };
      };
      b.maybeSingle = async () => ({ data: h.single[table] ?? null });
      // the expenses list is awaited directly after .eq()
      b.then = (res: (v: unknown) => unknown) => res({ data: h.rows[table] ?? [], error: null });
      return b;
    },
  }),
}));

import { GET as listCr } from "./change-requests/route";
import { GET as listDec } from "./decisions/route";
import { GET as evm } from "./projects/[id]/evm/route";
import { computeEvm } from "@/lib/evm";

const WS = "ws-1";
const PID = "22222222-2222-4222-8222-222222222222";
const tokenActor = (scopes: string[]): Actor => ({ type: "token", id: "t", label: "t", workspaceId: WS, scopes, principalId: "u" });
const req = (path: string) => new NextRequest(`http://localhost:3000${path}`);
const ctx = (id = PID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  h.calls.length = 0;
  h.rows = {};
  h.single = {};
  h.actor = tokenActor(["change:read", "decision:read", "budget:read"]);
});

describe("GET /api/change-requests", () => {
  it("filters by workspace, project and status, summary by default, paged", async () => {
    h.rows.change_requests = [{ id: "a" }];
    const res = await listCr(req(`/api/change-requests?project_id=${PID}&status=raised&page=2&limit=5`), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: [{ id: "a" }], page: 2, limit: 5 });
    const c = h.calls[0];
    expect(c.eq).toEqual([["workspace_id", WS], ["project_id", PID], ["status", "raised"]]);
    expect(c.range).toEqual([5, 9]);
    expect(c.select).toContain("title");
    expect(c.select).not.toContain("description");
  });
  it("view=full selects everything", async () => {
    await listCr(req("/api/change-requests?view=full"), ctx());
    expect(h.calls[0].select).toBe("*");
  });
  it("rejects an unknown field, a bad status and a bad project id with 422", async () => {
    for (const q of ["fields=nope", "status=zzz", "project_id=not-a-uuid"]) {
      const res = await listCr(req(`/api/change-requests?${q}`), ctx());
      expect(res.status, q).toBe(422);
    }
  });
  it("a token without change:read gets 403 and the database is never touched", async () => {
    h.actor = tokenActor(["decision:read"]);
    const res = await listCr(req("/api/change-requests"), ctx());
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });
});

describe("GET /api/decisions", () => {
  it("filters by workspace, project and status", async () => {
    await listDec(req(`/api/decisions?project_id=${PID}&status=accepted`), ctx());
    expect(h.calls[0].eq).toEqual([["workspace_id", WS], ["project_id", PID], ["status", "accepted"]]);
    expect(h.calls[0].range).toEqual([0, 19]);
  });
  it("clamps limit to 100", async () => {
    await listDec(req("/api/decisions?limit=9999"), ctx());
    expect(h.calls[0].range).toEqual([0, 99]);
  });
  it("a token without decision:read gets 403", async () => {
    h.actor = tokenActor(["change:read"]);
    expect((await listDec(req("/api/decisions"), ctx())).status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });
});

describe("GET /api/projects/:id/evm", () => {
  it("returns the same numbers computeEvm gives the Budget page", async () => {
    h.single.projects = { id: PID, completion_pct: 40, baseline_start_date: "2026-01-01", baseline_target_date: "2026-12-31", currency: "MYR" };
    h.single.project_budget = { planned_amount: 1000, committed_amount: 300, currency: "MYR" };
    h.rows.expenses = [{ amount: 200 }, { amount: 100 }];
    const res = await evm(req(`/api/projects/${PID}/evm`), ctx());
    expect(res.status).toBe(200);
    const { data } = await res.json();
    const expected = computeEvm({
      planned_amount: 1000, completion_pct: 40, committed_amount: 300, actual_amount: 300,
      baseline_start_date: "2026-01-01", baseline_target_date: "2026-12-31", as_of_date: "2026-06-01",
    });
    expect(data).toMatchObject({ ...expected, project_id: PID, currency: "MYR", as_of_date: "2026-06-01", schedule_basis: "baseline_dates" });
    expect(data.committed).toBe(300);
  });
  it("without a budget or baseline: zeros, null indexes, completion_only", async () => {
    h.single.projects = { id: PID, completion_pct: 0, baseline_start_date: null, baseline_target_date: null, currency: null };
    const { data } = await (await evm(req(`/api/projects/${PID}/evm`), ctx())).json();
    expect(data).toMatchObject({ bac: 0, ac: 0, cpi: null, eac: null, schedule_basis: "completion_only", currency: "USD" });
  });
  it("scopes the project lookup to the workspace and 404s a project outside it", async () => {
    const res = await evm(req(`/api/projects/${PID}/evm`), ctx());
    expect(res.status).toBe(404);
    expect(h.calls[0]).toMatchObject({ table: "projects", eq: [["id", PID], ["workspace_id", WS]] });
  });
  it("a token without budget:read gets 403", async () => {
    h.actor = tokenActor(["change:read"]);
    expect((await evm(req(`/api/projects/${PID}/evm`), ctx())).status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });
});

describe("GET /api/documents/:id (used by get_document)", () => {
  it("selects an explicit column list that omits storage_path but keeps the text body", async () => {
    h.actor = tokenActor(["document:read"]);
    h.single.documents = { id: "d", title: "Charter", body: "text" };
    const { GET: getDoc } = await import("./documents/[id]/route");
    const res = await getDoc(req("/api/documents/d"), ctx("d"));
    expect(res.status).toBe(200);
    const select = h.calls[0].select ?? "";
    expect(select).not.toBe("*");
    expect(select.split(",")).not.toContain("storage_path");
    for (const col of ["id", "title", "body", "external_url", "file_name", "file_size"]) {
      expect(select.split(",")).toContain(col);
    }
    expect(h.calls[0].eq).toEqual([["id", "d"], ["workspace_id", WS]]);
  });
});

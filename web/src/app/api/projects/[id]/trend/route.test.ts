import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const h = vi.hoisted(() => ({
  project: { id: "p1", rag_status: "green" } as Record<string, unknown> | null,
  snapshots: [] as Record<string, unknown>[],
  seen: [] as Array<[string, unknown[]]>,
  auth: (async (): Promise<unknown> => ({ type: "token", id: "t", label: "t", workspaceId: "w", scopes: ["project:read"], principalId: "u" })) as (...a: unknown[]) => Promise<unknown>,
}));
vi.mock("@/lib/auth/guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/guard")>()),
  requireAuth: (...args: unknown[]) => h.auth(...args),
}));
vi.mock("@/lib/api/rate-limit", () => ({ checkRateLimit: async () => undefined }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) {
        b[m] = (...args: unknown[]) => {
          h.seen.push([`${table}.${m}`, args]);
          return b;
        };
      }
      b.maybeSingle = async () => ({ data: table === "projects" ? h.project : null, error: null });
      b.then = (res: (v: unknown) => unknown) => res({ data: h.snapshots, error: null });
      return b;
    },
  }),
}));

import { GET } from "./route";

const get = (qs = "") =>
  GET(new NextRequest(`http://localhost/api/projects/p1/trend${qs}`), { params: Promise.resolve({ id: "p1" }) });

beforeEach(() => {
  h.project = { id: "p1", rag_status: "green" };
  h.snapshots = [];
  h.seen.length = 0;
  h.auth = async () => ({ type: "token", id: "t", label: "t", workspaceId: "w", scopes: ["project:read"], principalId: "u" } satisfies Actor);
});

describe("GET /api/projects/:id/trend", () => {
  it("404s a project outside the workspace", async () => {
    h.project = null;
    expect((await get()).status).toBe(404);
  });

  it("returns the series oldest first with a suggestion that leaves the declared RAG alone", async () => {
    // Stored newest first by the query; the route hands the series back oldest first.
    h.snapshots = [3, 2, 1].map((n) => ({
      taken_at: `2026-10-0${n}`, spi: 0.8, cpi: 0.8, slip_days: 12, completion_pct: 40,
    }));
    const res = await get();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.series.map((s: { taken_at: string }) => s.taken_at)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(data.declared_rag).toBe("green");
    expect(data.suggested_rag).toBe("red");
    expect(data.thresholds.redSlipDays).toBe(10);
    // read-only: no insert/update/upsert was attempted
    expect(h.seen.some(([k]) => /insert|update|upsert|delete/.test(k))).toBe(false);
  });

  it("403s a token without project:read and reads nothing", async () => {
    h.auth = async () => ({ type: "token", id: "t", label: "t", workspaceId: "w", scopes: ["task:read"], principalId: "u" } satisfies Actor);
    const res = await get();
    expect(res.status).toBe(403);
    expect(h.seen).toHaveLength(0);
  });

  it.each([
    ["?n=500", 120],
    ["?n=0", 1],
    ["?n=-5", 1],
    ["?n=abc", 28],
    ["", 28],
  ])("clamps %s to a window of %i", async (qs, expected) => {
    await get(qs);
    expect(h.seen).toContainEqual(["project_snapshots.limit", [expected]]);
  });

  it("has no suggestion before the first snapshot", async () => {
    const { data } = await (await get()).json();
    expect(data.suggested_rag).toBeNull();
    expect(data.series).toEqual([]);
  });

  it("filters the series by workspace and project and honours n", async () => {
    await get("?n=7");
    expect(h.seen).toContainEqual(["project_snapshots.eq", ["workspace_id", "w"]]);
    expect(h.seen).toContainEqual(["project_snapshots.eq", ["project_id", "p1"]]);
    expect(h.seen).toContainEqual(["project_snapshots.limit", [7]]);
  });
});

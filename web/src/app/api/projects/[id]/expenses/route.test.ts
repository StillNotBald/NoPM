import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const h = vi.hoisted(() => ({ inserted: [] as Record<string, unknown>[] }));
vi.mock("@/lib/audit/write", () => ({ writeAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/auth/guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/guard")>()),
  requireAuth: vi.fn(async (): Promise<Actor> => ({
    type: "user", id: "u", label: "u", workspaceId: "w", role: "manager", principalId: "u",
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    // nopm_mutate_audited (migration 0103): the insert and its audit row; the patch is what was inserted.
    rpc: async (name: string, a: { p_patch?: Record<string, unknown> }) => {
      if (name !== "nopm_mutate_audited") return { data: { allowed: true }, error: null };
      h.inserted.push(a.p_patch as Record<string, unknown>);
      return { data: { before: null, after: { id: "e1", ...a.p_patch } }, error: null };
    },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "range"]) b[m] = () => b;
      b.insert = (row: Record<string, unknown>) => {
        h.inserted.push(row);
        return { select: () => ({ single: async () => ({ data: { id: "e1", ...row }, error: null }) }) };
      };
      b.maybeSingle = async () => ({
        data: table === "projects" ? { id: "p" } : table === "workspaces" ? { time_zone: "Asia/Kuala_Lumpur" } : null,
      });
      return b;
    },
  }),
}));

import { POST } from "./route";

const call = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/projects/p/expenses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "p" }) },
  );

beforeEach(() => {
  h.inserted.length = 0;
});

describe("POST /api/projects/:id/expenses", () => {
  it("defaults incurred_on to today in the workspace zone, not UTC", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-17T16:30:00Z")); // 00:30 on the 18th in Kuala Lumpur
      const res = await call({ description: "Cab", amount: 12 });
      expect(res.status).toBe(201);
      expect(h.inserted[0].incurred_on).toBe("2026-10-18");
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps an explicit incurred_on", async () => {
    await call({ description: "Cab", amount: 12, incurred_on: "2026-10-01" });
    expect(h.inserted[0].incurred_on).toBe("2026-10-01");
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const h = vi.hoisted(() => ({ selects: [] as string[] }));

vi.mock("@/lib/auth/guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/guard")>()),
  requireAuth: vi.fn(async (): Promise<Actor> => ({
    type: "user", id: "u", label: "u", workspaceId: "w", role: "manager", principalId: "u",
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: { allowed: true }, error: null }),
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["eq", "order", "range"]) b[m] = () => b;
      b.select = (cols: string) => {
        h.selects.push(cols);
        return b;
      };
      b.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
      return b;
    },
  }),
}));

import { GET } from "./route";

const list = (qs = "") => GET(new NextRequest(`http://localhost/api/projects${qs}`), { params: Promise.resolve({}) });
const rowSelect = () => h.selects[h.selects.length - 1];

beforeEach(() => {
  h.selects.length = 0;
});

describe("GET /api/projects payload (R-129)", () => {
  it("returns the summary columns by default - no charter text, no lock detail, no seam columns", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    const cols = rowSelect().split(",");
    for (const c of ["business_case", "objective", "scope_summary", "health_commentary", "lock_reason", "locked_by", "locked_at", "source", "external_ref"]) {
      expect(cols, c).not.toContain(c);
    }
    expect(cols).toEqual(expect.arrayContaining(["id", "code", "name", "rag_status", "is_locked", "updated_at"]));
  });

  it("view=full selects every column", async () => {
    await list("?view=full");
    expect(rowSelect()).toBe("*");
  });

  it("fields=... selects exactly those columns plus id", async () => {
    await list("?fields=name,rag_status");
    expect(rowSelect()).toBe("id,name,rag_status");
  });

  it("an unknown field is a 422 and never reaches the database", async () => {
    const res = await list("?fields=name,secret");
    expect(res.status).toBe(422);
    expect(h.selects).toEqual([]);
  });
});

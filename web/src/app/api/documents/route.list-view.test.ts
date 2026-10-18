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

const list = (qs = "") => GET(new NextRequest(`http://localhost/api/documents${qs}`), { params: Promise.resolve({}) });
const rowSelect = () => h.selects[h.selects.length - 1];

beforeEach(() => {
  h.selects.length = 0;
});

describe("GET /api/documents payload (R-173)", () => {
  it("returns the summary columns by default: no body, summary, evidence note or storage path", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    const cols = rowSelect().split(",");
    for (const c of ["body", "summary", "evidence_note", "storage_path", "workspace_id"]) expect(cols, c).not.toContain(c);
    expect(cols).toEqual(expect.arrayContaining(["id", "reference_id", "title", "doc_type", "status", "change_request_id", "evidence_type", "created_at"]));
  });

  it("filters still apply with the lean select", async () => {
    const res = await list("?change_request_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1&status=draft");
    expect(res.status).toBe(200);
  });

  it("view=full selects every column except storage_path", async () => {
    await list("?view=full");
    const cols = rowSelect().split(",");
    expect(cols).toEqual(expect.arrayContaining(["body", "summary", "evidence_note"]));
    expect(cols).not.toContain("storage_path");
  });

  it("fields=... selects exactly those columns plus id, and body only when named", async () => {
    await list("?fields=title,body");
    expect(rowSelect()).toBe("id,title,body");
  });

  it("storage_path and unknown fields are a 422 and never reach the database", async () => {
    expect((await list("?fields=title,storage_path")).status).toBe(422);
    expect((await list("?fields=secret")).status).toBe(422);
    expect((await list("?view=huge")).status).toBe(422);
    expect(h.selects).toEqual([]);
  });
});

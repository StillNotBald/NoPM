import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const h = vi.hoisted(() => ({ updates: [] as Record<string, unknown>[], programFound: true }));
const EXISTING = {
  id: "p1", workspace_id: "w", name: "Apollo", completion_pct: 40, updated_at: "2026-10-01T00:00:00Z",
};
const PROGRAM = "33333333-3333-4333-8333-333333333333";
vi.mock("@/lib/audit/write", () => ({ writeAudit: vi.fn(async () => {}) }));
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
      let isUpdate = false;
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in"]) b[m] = () => b;
      b.update = (u: Record<string, unknown>) => {
        isUpdate = true;
        h.updates.push(u);
        return b;
      };
      b.maybeSingle = async () => ({
        data: isUpdate ? { ...EXISTING, ...h.updates[h.updates.length - 1] } : EXISTING,
        error: null,
      });
      // assertRefsInWorkspace batches an `in` query and awaits the builder itself.
      b.then = (res: (v: unknown) => unknown) =>
        res({ data: table === "programs" && h.programFound ? [{ id: PROGRAM }] : [], error: null });
      return b;
    },
  }),
}));

import { PATCH } from "./route";

const patch = (body: unknown) =>
  PATCH(
    new NextRequest("http://localhost/api/projects/p1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "p1" }) },
  );

beforeEach(() => {
  h.updates.length = 0;
  h.programFound = true;
});

describe("PATCH /api/projects/:id", () => {
  it("refuses a completion_pct that differs from the roll-up (422)", async () => {
    const res = await patch({ completion_pct: 90 });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("Project completion is calculated from its tasks");
    expect(h.updates).toHaveLength(0);
  });

  it("tolerates an echoed completion_pct and does not write it", async () => {
    const res = await patch({ completion_pct: 40, name: "Apollo 2" });
    expect(res.status).toBe(200);
    expect("completion_pct" in h.updates[0]).toBe(false);
  });

  it("saves program_id for a program in the workspace", async () => {
    const res = await patch({ program_id: PROGRAM });
    expect(res.status).toBe(200);
    expect(h.updates[0].program_id).toBe(PROGRAM);
  });

  it("422 when the program is not in the workspace", async () => {
    h.programFound = false;
    const res = await patch({ program_id: PROGRAM });
    expect(res.status).toBe(422);
  });
});

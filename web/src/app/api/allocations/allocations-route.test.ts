/**
 * POST/PATCH /api/allocations — 422 on null pct (D-WRK-18), Idempotency-Key
 * replay (D-WRK-12) and fail-soft clash detection (D-WRK-11).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FakeDb } from "@/lib/governance/test-support/fake-admin";

const { holder, authHolder, detect } = vi.hoisted(() => ({
  holder: { db: null as unknown },
  authHolder: { actor: null as unknown },
  detect: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (holder.db as FakeDb).client }));
vi.mock("@/lib/clash/detect", () => ({ detectOverAllocationSafe: detect }));
vi.mock("@/lib/notify/publish", () => ({
  notify: async () => undefined,
  resolveWorkspaceApprovers: async () => [],
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/auth/mfa", () => ({
  MFA_COOKIE_NAME: "nopm_mfa",
  getMfaEnrollmentStatus: async () => ({ enabled: false, enr: null }),
  verifyMfaCookie: () => false,
}));
vi.mock("@/lib/auth/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/guard")>();
  return { ...actual, requireAuth: async () => authHolder.actor as Actor };
});

import { POST } from "./route";
import { PATCH } from "./[id]/route";

const W1 = "11111111-1111-4111-8111-111111111111";
const M1 = "22222222-2222-4222-8222-222222222222";
const A1 = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  holder.db = new FakeDb({
    resource_members: [{ id: M1, workspace_id: W1 }],
    allocations: [{ id: A1, workspace_id: W1, member_id: M1, allocation_pct: 50 }],
  });
  authHolder.actor = {
    type: "user", id: "usr_1", label: "Admin", workspaceId: W1, role: "admin",
    principalId: "usr_1", channel: "ui", requestId: "r",
  } satisfies Actor;
  detect.mockReset();
  detect.mockResolvedValue({ detected: false, warning: null });
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("http://localhost/api/allocations", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
}
const db = () => holder.db as FakeDb;

describe("allocation_pct validation", () => {
  it("POST null allocation_pct -> 422, nothing written", async () => {
    const res = await post({ member_id: M1, allocation_pct: null });
    expect(res.status).toBe(422);
    expect(db().rows("allocations")).toHaveLength(1);
  });
  it("PATCH null allocation_pct -> 422", async () => {
    const res = await PATCH(
      new NextRequest("http://localhost/api/allocations/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allocation_pct: null }),
      }),
      { params: Promise.resolve({ id: A1 }) },
    );
    expect(res.status).toBe(422);
  });
  it("omitting allocation_pct is still accepted", async () => {
    expect((await post({ member_id: M1 })).status).toBe(201);
  });
});

describe("Idempotency-Key", () => {
  it("replays the same record: one allocation, one audit row", async () => {
    const h = { "Idempotency-Key": "abc-123" };
    const r1 = await post({ member_id: M1, allocation_pct: 30 }, h);
    const r2 = await post({ member_id: M1, allocation_pct: 30 }, h);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect((await r2.json()).data.id).toBe((await r1.json()).data.id);
    expect(db().rows("allocations")).toHaveLength(2); // seed + one
    expect(db().rows("audit_log").filter((a) => a.action === "allocation.create")).toHaveLength(1);
    expect(detect).toHaveBeenCalledTimes(1);
  });
  it("without a key every POST creates", async () => {
    await post({ member_id: M1 });
    await post({ member_id: M1 });
    expect(db().rows("allocations")).toHaveLength(3);
  });
});

describe("fail-soft detection", () => {
  it("returns 201 with a warning when the detector reports failure", async () => {
    detect.mockResolvedValue({ detected: false, warning: "detection failed" });
    const res = await post({ member_id: M1, allocation_pct: 20 });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.warnings).toEqual(["detection failed"]);
    expect(json.data.member_id).toBe(M1);
  });
  it("omits warnings on a clean run", async () => {
    const json = await (await post({ member_id: M1 })).json();
    expect(json.warnings).toBeUndefined();
  });
});

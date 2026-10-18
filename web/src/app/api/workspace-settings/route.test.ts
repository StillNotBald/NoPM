import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { writeAuditMock, requireAuthMock } = vi.hoisted(() => ({
  writeAuditMock: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
  requireAuthMock: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/audit/write", () => ({ writeAudit: writeAuditMock }));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: requireAuthMock,
}));

import { FakeDb, TEST_ENCRYPTION_KEY, WS, ids, seedWorkspace } from "@/lib/integrations/test-support";
import { GET, PATCH } from "./route";

const NO_PARAMS = { params: Promise.resolve({}) };
const actor = (role: string): Actor => ({ type: "user", id: ids.admin, label: "A", workspaceId: WS, role, principalId: ids.admin }) as Actor;
const patch = (body: unknown) =>
  PATCH(new NextRequest("http://localhost:3000/api/workspace-settings", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), NO_PARAMS);

let db: FakeDb;
beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  writeAuditMock.mockReset();
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue(actor("admin"));
  db = new FakeDb();
  state.db = db;
  seedWorkspace(db);
});

describe("/api/workspace-settings", () => {
  it("GET defaults to Malaysia when the column is unset", async () => {
    const res = await GET(new NextRequest("http://localhost:3000/api/workspace-settings"), NO_PARAMS);
    expect((await res.json()).data.time_zone).toBe("Asia/Kuala_Lumpur");
  });
  it("PATCH saves a valid zone with exactly one audit row", async () => {
    const res = await patch({ time_zone: "Asia/Singapore" });
    expect(res.status).toBe(200);
    expect(db.rows("workspaces").find((w) => w.id === WS)?.time_zone).toBe("Asia/Singapore");
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({ action: "workspace.settings_update", after: { time_zone: "Asia/Singapore" } });
  });
  it("PATCH with the same zone writes nothing and no audit row", async () => {
    await patch({ time_zone: "Asia/Kuala_Lumpur" });
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
  it("rejects an unknown zone with 422 and changes nothing", async () => {
    const res = await patch({ time_zone: "Mars/Base" });
    expect(res.status).toBe(422);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
  it("is admin-only", async () => {
    requireAuthMock.mockResolvedValue(actor("manager"));
    expect((await patch({ time_zone: "Asia/Singapore" })).status).toBe(403);
  });
});

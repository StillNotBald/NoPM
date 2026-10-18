import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { writeAuditMock, requireAuthMock, drainMock } = vi.hoisted(() => ({
  writeAuditMock: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
  requireAuthMock: vi.fn(),
  drainMock: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/audit/write", () => ({ writeAudit: writeAuditMock }));
vi.mock("@/lib/integrations/lark", () => ({ larkAdapter: undefined }));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: requireAuthMock,
}));
vi.mock("@/lib/integrations/deliveries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/deliveries")>()),
  drainDeliveries: drainMock,
}));

import { CONNECTOR_ID, FakeDb, OTHER_WS, TEST_ENCRYPTION_KEY, WS, ids, seedWorkspace } from "@/lib/integrations/test-support";
import { GET } from "./route";
import { POST as retry } from "./[deliveryId]/retry/route";

const admin = (over: Partial<Actor> = {}): Actor => ({ type: "user", id: ids.admin, label: "Ada", workspaceId: WS, role: "admin", principalId: ids.admin, ...over });
const base = `http://localhost:3000/api/integrations/connectors/${CONNECTOR_ID}/deliveries`;
const listParams = { params: Promise.resolve({ id: CONNECTOR_ID }) };
const retryParams = (deliveryId: string) => ({ params: Promise.resolve({ id: CONNECTOR_ID, deliveryId }) });

let db: FakeDb;
const dead = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspace_id: WS,
  connector_id: CONNECTOR_ID,
  kind: "approval_card",
  approval_kind: "rebaseline_signoff",
  approval_id: "r1",
  status: "dead",
  attempts: 6,
  last_error: "Lark said no (code 99)",
  payload: { secret: "never returned" },
  created_at: "2026-10-16T01:00:00Z",
  next_attempt_at: "2026-10-16T01:00:00Z",
  ...over,
});

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue(admin());
  drainMock.mockReset();
  drainMock.mockResolvedValue({ claimed: 1, sent: 1, retried: 0, dead: 0, superseded: 0, deferred: 0, deadlineSkipped: 0 });
  db = new FakeDb();
  state.db = db;
  seedWorkspace(db);
  db.seed("integration_deliveries", [dead("dl-1"), dead("dl-2", { status: "sent" }), dead("dl-x", { workspace_id: OTHER_WS })]);
});
afterEach(() => vi.unstubAllEnvs());

describe("GET .../deliveries", () => {
  it("lists only this connector's dead messages, without payload", async () => {
    const res = await GET(new NextRequest(`${base}?status=dead`), listParams);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    expect(body.data.map((d) => d.id)).toEqual(["dl-1"]);
    expect(body.data[0]).not.toHaveProperty("payload");
    expect(body.data[0].last_error).toContain("code 99");
  });
  it("is admin-only", async () => {
    requireAuthMock.mockResolvedValue(admin({ role: "manager" }));
    expect((await GET(new NextRequest(base), listParams)).status).toBe(403);
  });
});

describe("POST .../retry", () => {
  const call = (id: string) => retry(new NextRequest(`${base}/${id}/retry`, { method: "POST" }), retryParams(id));

  it("requeues a dead message with fresh attempts, audits once, and tries it now", async () => {
    const res = await call("dl-1");
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ delivery_id: "dl-1", status: "sent" });
    const row = db.rows("integration_deliveries").find((d) => d.id === "dl-1")!;
    expect(row).toMatchObject({ status: "pending", attempts: 0 });
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({ action: "integration.delivery.retry", targetId: "dl-1" });
    expect(drainMock).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, ids: ["dl-1"] }));
  });
  it("refuses a message that is not dead, and another workspace's", async () => {
    expect((await call("dl-2")).status).toBe(422);
    expect((await call("dl-x")).status).toBe(404);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
  it("is admin-only and needs an active connector", async () => {
    requireAuthMock.mockResolvedValue(admin({ role: "manager" }));
    expect((await call("dl-1")).status).toBe(403);
    requireAuthMock.mockResolvedValue(admin());
    db.seed("integration_connectors", []);
    db.rows("integration_connectors")[0].status = "paused";
    expect((await call("dl-1")).status).toBe(422);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { writeAuditMock, requireAuthMock } = vi.hoisted(() => ({
  writeAuditMock: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
  requireAuthMock: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/audit/write", () => ({ writeAudit: writeAuditMock }));
vi.mock("@/lib/integrations/lark", () => ({ larkAdapter: undefined }));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: requireAuthMock,
}));

import { clearAdapters, registerAdapter } from "@/lib/integrations/deliveries";
import {
  CONNECTOR_ID,
  FakeDb,
  TEST_ENCRYPTION_KEY,
  WS,
  createFakeAdapter,
  ids,
  linkIdentity,
  seedWorkspace,
} from "@/lib/integrations/test-support";
import { POST } from "./route";

// F2 of the 2026-10-17 integration review: the "Requeue dead" admin action.

const params = (id = CONNECTOR_ID) => ({ params: Promise.resolve({ id }) });
const req = () =>
  new NextRequest(`http://localhost:3000/api/integrations/connectors/${CONNECTOR_ID}/requeue-dead`, { method: "POST" });
const actor = (over: Partial<Actor> = {}): Actor => ({
  type: "user",
  id: ids.admin,
  label: "Ada Admin",
  workspaceId: WS,
  role: "admin",
  principalId: ids.admin,
  ...over,
});

let db: FakeDb;
let fake: ReturnType<typeof createFakeAdapter>;

const deadCard = () => ({
  id: "dead-card-1",
  workspace_id: WS,
  connector_id: CONNECTOR_ID,
  kind: "approval_card",
  approval_kind: "change_request",
  approval_id: ids.approval,
  recipient_profile_id: ids.manager,
  external_target: "ou_max",
  status: "dead",
  attempts: 6,
  next_attempt_at: "2026-10-16T01:00:00.000Z",
  last_error: "network error",
  payload: {},
  created_at: "2026-10-16T01:00:00.000Z",
});

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue(actor());
  db = new FakeDb();
  state.db = db;
  seedWorkspace(db);
  linkIdentity(db, ids.manager, "ou_max");
  fake = createFakeAdapter();
  clearAdapters();
  registerAdapter(fake.adapter);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST .../requeue-dead", () => {
  it("sends a fresh card for a still-pending request whose card went dead, audited first", async () => {
    db.seed("integration_deliveries", [deadCard()]);

    const res = await POST(req(), params());

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ dead_requests: 1, still_pending: 1 });
    expect(fake.calls.cards).toHaveLength(1);
    const live = db.rows("integration_deliveries").filter((d) => d.status !== "dead");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ kind: "approval_card", approval_id: ids.approval, recipient_profile_id: ids.manager });
    // the dead row stays as history
    expect(db.rows("integration_deliveries").find((d) => d.id === "dead-card-1")?.status).toBe("dead");

    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({
      workspaceId: WS,
      action: "integration.approvals.requeue_dead",
      targetType: "integration_connector",
      targetId: CONNECTOR_ID,
      after: { dead_requests: 1, still_pending: 1 },
    });
  });

  it("does not duplicate: a second press finds the live card and sends nothing more", async () => {
    db.seed("integration_deliveries", [deadCard()]);
    await POST(req(), params());
    await POST(req(), params());
    expect(fake.calls.cards).toHaveLength(1);
  });

  it("leaves a request that was decided meanwhile alone", async () => {
    db.seed("integration_deliveries", [deadCard()]);
    db.rows("change_requests")[0].status = "approved";
    const res = await POST(req(), params());
    expect(((await res.json()) as { data: unknown }).data).toEqual({ dead_requests: 1, still_pending: 0 });
    expect(fake.calls.cards).toHaveLength(0);
  });

  it.each([
    ["a manager", actor({ role: "manager", id: ids.manager })],
    ["a member", actor({ role: "member", id: ids.member })],
    ["an API token", actor({ type: "token", role: "admin" })],
  ])("refuses %s with 403 and does nothing", async (_n, who) => {
    requireAuthMock.mockResolvedValue(who);
    db.seed("integration_deliveries", [deadCard()]);
    const res = await POST(req(), params());
    expect(res.status).toBe(403);
    expect(fake.calls.cards).toHaveLength(0);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("404s an unknown connector and 422s a paused one", async () => {
    expect((await POST(req(), params("00000000-0000-4000-8000-0000000000ff"))).status).toBe(404);
    db.rows("integration_connectors")[0].status = "paused";
    db.seed("integration_deliveries", [deadCard()]);
    const res = await POST(req(), params());
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("connector_not_active");
    expect(fake.calls.cards).toHaveLength(0);
  });

  it("is fail-closed: no audit row, no card", async () => {
    db.seed("integration_deliveries", [deadCard()]);
    writeAuditMock.mockRejectedValueOnce(new Error("audit down"));
    const res = await POST(req(), params());
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(fake.calls.cards).toHaveLength(0);
  });
});

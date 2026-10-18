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
  APP_SECRET,
  CONNECTOR_ID,
  FakeDb,
  OTHER_WS,
  TEST_ENCRYPTION_KEY,
  WS,
  connectorRow,
  createFakeAdapter,
  ids,
  seedWorkspace,
} from "@/lib/integrations/test-support";
import { POST as testConnection } from "./test/route";
import { POST as sendDigest } from "./digest/route";

const params = (id = CONNECTOR_ID) => ({ params: Promise.resolve({ id }) });
const admin = (over: Partial<Actor> = {}): Actor => ({
  type: "user",
  id: ids.admin,
  label: "Ada Admin",
  workspaceId: WS,
  role: "admin",
  principalId: ids.admin,
  ...over,
});
const req = (path: string) => new NextRequest(`http://localhost:3000/api/integrations/connectors/${CONNECTOR_ID}/${path}`, { method: "POST" });

let db: FakeDb;
let fake: ReturnType<typeof createFakeAdapter>;

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue(admin());
  db = new FakeDb();
  state.db = db;
  seedWorkspace(db);
  fake = createFakeAdapter();
  clearAdapters();
  registerAdapter(fake.adapter);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST .../test", () => {
  it("reports the bot name and writes NO audit row (a read-style probe)", async () => {
    const res = await testConnection(req("test"), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true, bot_name: "NoPM Bot" } });
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("returns ok:false with a sanitised, secret-free error when the platform rejects the credentials", async () => {
    fake.adapter.testConnection = async () => ({ ok: false, error: `invalid app secret ${APP_SECRET} (code 10003)` });
    const body = (await (await testConnection(req("test"), params())).json()) as { data: { ok: boolean; error: string } };
    expect(body.data.ok).toBe(false);
    expect(body.data.error).toContain("10003");
    expect(body.data.error).not.toContain(APP_SECRET);
  });

  it("turns an adapter crash into ok:false instead of a 500", async () => {
    fake.adapter.testConnection = async () => {
      throw new Error(`ECONNRESET with ${APP_SECRET}`);
    };
    const res = await testConnection(req("test"), params());
    const body = (await res.json()) as { data: { ok: boolean; error: string } };
    expect(res.status).toBe(200);
    expect(body.data.ok).toBe(false);
    expect(body.data.error).not.toContain(APP_SECRET);
  });

  it("explains unreadable stored credentials", async () => {
    db.rows("integration_connectors")[0].secret_enc = "bm9wZQ==.bm9wZQ==.bm9wZQ==";
    const body = (await (await testConnection(req("test"), params())).json()) as { data: { ok: boolean; error: string } };
    expect(body.data).toMatchObject({ ok: false, error: expect.stringMatching(/cannot be decrypted/) });
  });

  it("is admin-only, 404s for another workspace's connector and 422s for a revoked one", async () => {
    requireAuthMock.mockResolvedValue(admin({ role: "manager" }));
    expect((await testConnection(req("test"), params())).status).toBe(403);
    requireAuthMock.mockResolvedValue(admin());
    db.seed("integration_connectors", [connectorRow({ id: "foreign", workspace_id: OTHER_WS })]);
    expect((await testConnection(req("test"), params("foreign"))).status).toBe(404);
    db.rows("integration_connectors")[0].status = "revoked";
    expect((await testConnection(req("test"), params())).status).toBe(422);
  });
});

describe("POST .../digest (send now)", () => {
  const setDigest = (digest: Record<string, unknown>) => {
    const row = db.rows("integration_connectors")[0];
    row.config = { ...(row.config as object), digest };
  };
  beforeEach(() => {
    db.seed("projects", [{ id: "p1", workspace_id: WS, name: "Apollo", rag_status: "red", is_locked: false }]);
    setDigest({ enabled: false, chatId: "oc_team", weekday: 1 });
  });

  it("posts the digest to the configured group chat now, audited, tagged manual", async () => {
    const res = await sendDigest(req("digest"), params());
    const body = (await res.json()) as { data: { delivery_id: string; status: string } };

    expect(res.status).toBe(200);
    expect(body.data.status).toBe("sent");
    const delivery = db.rows("integration_deliveries")[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    // the delivery id is the platform idempotency key, so a retry can never double-post
    expect(fake.calls.sends).toEqual([
      { receiveIdType: "chat_id", receiveId: "oc_team", body: { card: "digest", projects: 1 }, idempotencyKey: delivery.id },
    ]);
    expect(delivery).toMatchObject({ id: body.data.delivery_id, kind: "digest", status: "sent", workspace_id: WS });
    expect(delivery.payload.trigger).toBe("manual");

    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({
      workspaceId: WS,
      action: "integration.digest.send",
      targetId: CONNECTOR_ID,
      after: { trigger: "manual", chat_id: "oc…" },
    });
  });

  it("works even when the weekly schedule is disabled (it is a manual action)", async () => {
    setDigest({ enabled: false, chatId: "oc_team", weekday: 1 });
    expect((await sendDigest(req("digest"), params())).status).toBe(200);
  });

  it("reports retry when the platform is failing, leaving the row for the cron to retry", async () => {
    fake.state.sendResult = async () => ({ ok: false, retryable: true, error: "503" });
    const body = (await (await sendDigest(req("digest"), params())).json()) as { data: { status: string } };
    expect(body.data.status).toBe("retry");
    expect(db.rows("integration_deliveries")[0].status).toBe("retry");
  });

  it("422s without a configured group chat, or while the connector is paused", async () => {
    setDigest({ enabled: true, chatId: null, weekday: 1 });
    const noChat = await sendDigest(req("digest"), params());
    expect(noChat.status).toBe(422);
    expect(((await noChat.json()) as { code: string }).code).toBe("digest_chat_missing");

    setDigest({ enabled: true, chatId: "oc_team", weekday: 1 });
    db.rows("integration_connectors")[0].status = "paused";
    const paused = await sendDigest(req("digest"), params());
    expect(paused.status).toBe(422);
    expect(db.rows("integration_deliveries")).toHaveLength(0);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("is fail-closed: no audit row, no send", async () => {
    writeAuditMock.mockRejectedValueOnce(new Error("audit down"));
    const res = await sendDigest(req("digest"), params());
    expect(res.status).toBe(500);
    expect(db.rows("integration_deliveries")).toHaveLength(0);
    expect(fake.calls.sends).toHaveLength(0);
  });

  it("is admin-only", async () => {
    requireAuthMock.mockResolvedValue(admin({ role: "manager" }));
    expect((await sendDigest(req("digest"), params())).status).toBe(403);
    expect(fake.calls.sends).toHaveLength(0);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";

// The handlers run for real; only the database (an in-memory fake that keeps
// real rows), the audit writer and session/token resolution are stubbed.
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

import { decryptSecrets } from "@/lib/integrations/secrets";
import { CONNECTOR_ID, FakeDb, OTHER_WS, TEST_ENCRYPTION_KEY, WS, connectorRow, ids, seedWorkspace } from "@/lib/integrations/test-support";
import { GET, POST } from "./route";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const NO_PARAMS = { params: Promise.resolve({}) };

const admin = (over: Partial<Actor> = {}): Actor => ({
  type: "user",
  id: ids.admin,
  label: "Ada Admin",
  workspaceId: WS,
  role: "admin",
  principalId: ids.admin,
  ...over,
});

const validBody = {
  name: "Acme Lark",
  region: "lark",
  app_id: "cli_a1b2c3",
  app_secret: "the-app-secret-0001",
  verification_token: "the-verification-token-0002",
  encrypt_key: "valid-encrypt-key-0004", // webhook mode (the default) requires one
};

const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost:3000/api/integrations/connectors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    NO_PARAMS,
  );

let db: FakeDb;

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue(admin());
  db = new FakeDb();
  state.db = db;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/integrations/connectors", () => {
  it("lists the workspace's connectors as public views — no ciphertext, hash or secret values", async () => {
    seedWorkspace(db);
    db.seed("integration_connectors", [connectorRow({ id: "other", workspace_id: OTHER_WS, name: "Foreign Lark", status: "revoked", relay_secret_hash: null })]);

    const res = await GET(new NextRequest("http://localhost:3000/api/integrations/connectors"), NO_PARAMS);
    const text = await res.text();
    const body = JSON.parse(text) as { data: Record<string, unknown>[]; total: number };

    expect(res.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.data[0]).toMatchObject({
      name: "Team Lark",
      status: "active",
      app_id: "cli_a1b2c3",
      has_app_secret: true,
      has_verification_token: true,
      has_encrypt_key: false,
      has_relay_secret: true,
    });
    expect(text).not.toContain("secret_enc");
    expect(text).not.toContain("relay_secret_hash");
    expect(text).not.toContain("app-secret-value-123");
    expect(text).not.toContain("Foreign Lark");
  });

  it("gives the admin the callback urls for the Lark console setup (from NEXT_PUBLIC_APP_URL when set)", async () => {
    seedWorkspace(db);
    const res = await GET(new NextRequest("http://localhost:3000/api/integrations/connectors"), NO_PARAMS);
    const body = (await res.json()) as { data: { id: string; callback_urls: Record<string, string> }[] };
    expect(body.data[0].callback_urls).toEqual({
      events: `http://localhost:3000/api/integrations/lark/${CONNECTOR_ID}/events`,
      card: `http://localhost:3000/api/integrations/lark/${CONNECTOR_ID}/card`,
      relay: `http://localhost:3000/api/integrations/lark/${CONNECTOR_ID}/relay`,
    });

    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pm.example.test");
    const configured = (await (await GET(new NextRequest("http://localhost:3000/api/integrations/connectors"), NO_PARAMS)).json()) as typeof body;
    expect(configured.data[0].callback_urls.events).toBe(`https://pm.example.test/api/integrations/lark/${CONNECTOR_ID}/events`);
  });

  it("tells the admin whether the connector is pinned to a Lark tenant — never the tenant key itself", async () => {
    seedWorkspace(db);
    const get = async () => (await GET(new NextRequest("http://localhost:3000/api/integrations/connectors"), NO_PARAMS)).text();
    expect(JSON.parse(await get()).data[0].tenant_pinned).toBe(false);
    db.rows("integration_connectors")[0].tenant_key = "tenant-SECRETISH";
    const text = await get();
    expect(JSON.parse(text).data[0].tenant_pinned).toBe(true);
    expect(text).not.toContain("tenant-SECRETISH");
  });

  describe("redacted view for non-admin members", () => {
    beforeEach(() => {
      seedWorkspace(db);
      const row = db.rows("integration_connectors")[0];
      row.config = {
        region: "feishu",
        appId: "cli_secretish_app_id",
        mode: "long_connection",
        approvals: { enabled: true },
        digest: { enabled: true, chatId: "oc_private_room", weekday: 3 },
      };
      // a revoked connector from the same workspace must be invisible to members
      db.seed("integration_connectors", [
        connectorRow({ id: "old-revoked", status: "revoked", name: "Old Lark", revoked_at: "2026-09-01T00:00:00.000Z", relay_secret_hash: null }),
      ]);
    });

    it.each([
      ["a manager", admin({ role: "manager" })],
      ["a member", admin({ role: "member" })],
      ["a viewer", admin({ role: "viewer" })],
    ])("%s gets only id, name, kind, status, region, mode, approvals.enabled, digest.enabled", async (_label, actor) => {
      requireAuthMock.mockResolvedValue(actor);
      const res = await GET(new NextRequest("http://localhost:3000/api/integrations/connectors"), NO_PARAMS);
      const text = await res.text();
      const body = JSON.parse(text) as { data: Record<string, unknown>[]; total: number };

      expect(res.status).toBe(200);
      expect(body.total).toBe(1); // the revoked one is hidden
      expect(body.data[0]).toEqual({
        id: CONNECTOR_ID,
        name: "Team Lark",
        kind: "lark",
        status: "active",
        region: "feishu",
        mode: "long_connection",
        approvals: { enabled: true },
        digest: { enabled: true },
      });
      db.rows("integration_connectors")[0].tenant_key = "tenant-SECRETISH";
      requireAuthMock.mockResolvedValue(actor);
      const res2 = await GET(new NextRequest("http://localhost:3000/api/integrations/connectors"), NO_PARAMS);
      expect(await res2.text()).not.toMatch(/tenant/);
      for (const leaked of ["cli_secretish_app_id", "oc_private_room", "callback_urls", "has_app_secret", "secret_enc", "relay", "created_by", "Old Lark"]) {
        expect(text).not.toContain(leaked);
      }
    });

    it("a token is still refused (sessions only)", async () => {
      requireAuthMock.mockResolvedValue({ type: "token", id: "t", label: "t", workspaceId: WS, scopes: ["*"] } as Actor);
      const res = await GET(new NextRequest("http://localhost:3000/api/integrations/connectors"), NO_PARAMS);
      expect(res.status).toBe(403);
    });

    it("never shows another workspace's connector", async () => {
      db.seed("integration_connectors", [connectorRow({ id: "foreign", workspace_id: OTHER_WS, name: "Foreign Lark" })]);
      requireAuthMock.mockResolvedValue(admin({ role: "member" }));
      const text = await (await GET(new NextRequest("http://localhost:3000/api/integrations/connectors"), NO_PARAMS)).text();
      expect(text).not.toContain("Foreign Lark");
    });
  });
});

describe("POST /api/integrations/connectors", () => {
  it("creates the connector, encrypts the credentials, returns the relay secret ONCE and audits without secrets", async () => {
    const res = await post({ ...validBody, encrypt_key: "the-encrypt-key-0003", workspace_id: OTHER_WS });
    const text = await res.text();
    const body = JSON.parse(text) as { data: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(res.status).toBe(201);
    const row = db.rows("integration_connectors")[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(row.workspace_id).toBe(WS); // from the actor, never the body
    expect(row.created_by).toBe(ids.admin);
    expect(row).toMatchObject({ kind: "lark", name: "Acme Lark", status: "active" });
    expect(row.config).toEqual({
      region: "lark",
      appId: "cli_a1b2c3",
      mode: "webhook",
      approvals: { enabled: true },
      digest: { enabled: false, chatId: null, weekday: 1 },
    });

    // credentials are ciphertext at rest
    expect(row.secret_enc).not.toContain("the-app-secret-0001");
    expect(decryptSecrets(row.secret_enc)).toEqual({
      appSecret: "the-app-secret-0001",
      verificationToken: "the-verification-token-0002",
      encryptKey: "the-encrypt-key-0003",
    });

    // relay secret: raw in the response only, sha-256 in the table
    const relay = body.data.relay_secret as string;
    expect(relay).toMatch(/^npr_[A-Za-z0-9_-]{43}$/);
    expect(row.relay_secret_hash).toBe(sha256(relay));
    expect(JSON.stringify(db.tables)).not.toContain(relay);

    // response: public view + callback urls, never a credential
    expect(body.data).toMatchObject({ has_app_secret: true, has_encrypt_key: true, has_relay_secret: true });
    expect(body.data.callback_urls).toEqual({
      events: `http://localhost:3000/api/integrations/lark/${row.id}/events`,
      card: `http://localhost:3000/api/integrations/lark/${row.id}/card`,
      relay: `http://localhost:3000/api/integrations/lark/${row.id}/relay`,
    });
    for (const secret of ["the-app-secret-0001", "the-verification-token-0002", "the-encrypt-key-0003", row.secret_enc, row.relay_secret_hash]) {
      expect(text).not.toContain(secret);
    }

    // exactly one audit row, carrying no secret material
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const audit = writeAuditMock.mock.calls[0][0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(audit).toMatchObject({ workspaceId: WS, action: "integration.connector.create", targetType: "integration_connector", targetId: row.id });
    const auditText = JSON.stringify(audit);
    for (const secret of ["the-app-secret-0001", "the-verification-token-0002", "the-encrypt-key-0003", row.secret_enc, row.relay_secret_hash, relay]) {
      expect(auditText).not.toContain(secret);
    }
  });

  it("uses NEXT_PUBLIC_APP_URL for the callback urls when set", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pm.example.test/");
    const body = (await (await post(validBody)).json()) as { data: { callback_urls: { events: string } } };
    expect(body.data.callback_urls.events).toMatch(/^https:\/\/pm\.example\.test\/api\/integrations\/lark\/.+\/events$/);
  });

  it("accepts digest and long-connection settings", async () => {
    const res = await post({
      ...validBody,
      mode: "long_connection",
      approvals: { enabled: false },
      digest: { enabled: true, chat_id: "oc_teamchat1", weekday: 5 },
    });
    expect(res.status).toBe(201);
    expect(db.rows("integration_connectors")[0].config).toMatchObject({
      mode: "long_connection",
      approvals: { enabled: false },
      digest: { enabled: true, chatId: "oc_teamchat1", weekday: 5 },
    });
  });

  it.each([
    ["missing credentials", { name: "x", region: "lark", app_id: "cli_x" }],
    ["unknown region", { ...validBody, region: "mars" }],
    ["bad app id", { ...validBody, app_id: "has spaces!" }],
    ["digest enabled without a chat", { ...validBody, digest: { enabled: true } }],
    ["malformed chat id", { ...validBody, digest: { enabled: true, chat_id: "not-a-chat", weekday: 1 } }],
    ["weekday out of range", { ...validBody, digest: { enabled: false, weekday: 9 } }],
    ["unknown mode", { ...validBody, mode: "carrier-pigeon" }],
  ])("rejects %s with 422 and writes nothing", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(422);
    expect(db.rows("integration_connectors")).toHaveLength(0);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body with 422", async () => {
    const res = await POST(
      new NextRequest("http://localhost:3000/api/integrations/connectors", { method: "POST", body: "not json" }),
      NO_PARAMS,
    );
    expect(res.status).toBe(422);
  });

  it("allows only one live connector per workspace, but a replacement once the first is revoked", async () => {
    expect((await post(validBody)).status).toBe(201);
    const second = await post(validBody);
    expect(second.status).toBe(422);
    expect(((await second.json()) as { code: string }).code).toBe("connector_exists");
    expect(db.rows("integration_connectors")).toHaveLength(1);

    db.rows("integration_connectors")[0].status = "revoked";
    expect((await post(validBody)).status).toBe(201);
    expect(db.rows("integration_connectors")).toHaveLength(2);
  });

  it("is admin-only: managers, members and tokens get 403 and nothing is written", async () => {
    for (const actor of [
      admin({ role: "manager" }),
      admin({ role: "member" }),
      { type: "token", id: "t", label: "t", workspaceId: WS, scopes: ["*"] } as Actor,
    ]) {
      requireAuthMock.mockResolvedValue(actor);
      expect((await post(validBody)).status).toBe(403);
    }
    expect(db.rows("integration_connectors")).toHaveLength(0);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("returns a clear 503 when the server encryption key is not configured", async () => {
    vi.stubEnv("NOPM_ENCRYPTION_KEY", "");
    const res = await post(validBody);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("encryption_unavailable");
    expect(db.rows("integration_connectors")).toHaveLength(0);
  });

  it("the unauthenticated case never reaches the handler", async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error("Authentication required"), { status: 401 }));
    const res = await post(validBody);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(db.rows("integration_connectors")).toHaveLength(0);
  });
});

describe("GET /api/integrations/connectors — operator health (admin view)", () => {
  type Health = {
    pending: number;
    retry: number;
    dead: number;
    last_sent_at: string | null;
    last_error: string | null;
    last_cron_at: string | null;
    last_cron: Record<string, unknown> | null;
    cron_state_available: boolean;
    scheduler_stale: boolean | null;
  };
  const get = async (): Promise<{ text: string; data: { id: string; health: Health | null }[] }> => {
    const res = await GET(new NextRequest("http://localhost:3000/api/integrations/connectors"), NO_PARAMS);
    const text = await res.text();
    return { text, data: JSON.parse(text).data };
  };
  const delivery = (id: string, status: string, over: Record<string, unknown> = {}) => ({
    id,
    workspace_id: WS,
    connector_id: CONNECTOR_ID,
    kind: "digest",
    status,
    attempts: 1,
    created_at: "2026-10-16T01:00:00.000Z",
    next_attempt_at: "2026-10-16T01:00:00.000Z",
    sent_at: null,
    last_error: null,
    payload: { data: { projects: [{ name: "Secret Project Name" }] } },
    ...over,
  });

  beforeEach(() => seedWorkspace(db));

  it("counts the queue by status and reports the last send, the last failure and the last scheduler run", async () => {
    db.seed("integration_deliveries", [
      delivery("p1", "pending"),
      delivery("r1", "retry", { last_error: "lark 230002 (bot is not in the chat)", next_attempt_at: "2026-10-16T02:00:00.000Z" }),
      delivery("r2", "retry", { last_error: "network error [ETIMEDOUT]", next_attempt_at: "2026-10-16T03:00:00.000Z" }),
      delivery("d1", "dead", { last_error: "older failure", next_attempt_at: "2026-10-15T01:00:00.000Z" }),
      delivery("s1", "sent", { sent_at: "2026-10-16T01:05:00.000Z" }),
      delivery("s2", "sent", { sent_at: "2026-10-16T04:05:00.000Z" }),
      delivery("x1", "superseded", { last_error: "request already decided" }),
    ]);
    db.seed("integration_cron_state", [
      {
        connector_id: CONNECTOR_ID,
        workspace_id: WS,
        last_run_at: "2026-10-16T01:07:00.000Z",
        last_summary: { claimed: 3, sent: 2, retried: 1, dead: 0, superseded: 0, digest: "sent" },
      },
    ]);

    const { data } = await get();

    expect(data[0].health).toEqual({
      pending: 1,
      retry: 2,
      dead: 1,
      last_sent_at: "2026-10-16T04:05:00.000Z",
      last_error: "network error [ETIMEDOUT]",
      last_cron_at: "2026-10-16T01:07:00.000Z",
      last_cron: { claimed: 3, sent: 2, retried: 1, dead: 0, superseded: 0, digest: "sent" },
      cron_state_available: true,
      // the seeded scheduler record is from 2026-10-16: long past 36 hours by the time the suite runs
      scheduler_stale: true,
    });
  });

  it("a connector that has never sent or run reads as zeros and nulls, not as an error", async () => {
    const { data } = await get();
    expect(data[0].health).toEqual({
      pending: 0,
      retry: 0,
      dead: 0,
      last_sent_at: null,
      last_error: null,
      last_cron_at: null,
      last_cron: null,
      cron_state_available: true,
      scheduler_stale: expect.any(Boolean),
    });
  });

  it("counts only this connector's deliveries in this workspace, and never exposes payloads", async () => {
    db.seed("integration_deliveries", [
      delivery("mine", "dead"),
      delivery("theirs", "dead", { workspace_id: OTHER_WS, connector_id: "foreign-connector" }),
      delivery("same-ws-other-connector", "dead", { connector_id: "second-connector" }),
    ]);
    const { data, text } = await get();
    expect(data[0].health?.dead).toBe(1);
    expect(text).not.toContain("Secret Project Name");
    expect(text).not.toContain("payload");
  });

  it("is null for a revoked connector, and null (never a misleading zero) when the lookup fails", async () => {
    db.seed("integration_connectors", [connectorRow({ id: "old", status: "revoked", name: "Old", revoked_at: "2026-09-01T00:00:00.000Z" })]);
    db.failNext({ table: "integration_deliveries", op: "select", error: { message: "db down" } });

    const { data } = await get();

    const byId = Object.fromEntries(data.map((c) => [c.id, c.health]));
    expect(byId.old).toBeNull();
    expect(byId[CONNECTOR_ID]).toBeNull();
  });

  it("still reports the queue when the scheduler record is unavailable (migration not applied yet)", async () => {
    db.seed("integration_deliveries", [delivery("d1", "dead")]);
    db.failNext({ table: "integration_cron_state", op: "select", error: { message: "relation does not exist" } });
    const { data } = await get();
    expect(data[0].health).toMatchObject({ dead: 1, last_cron_at: null, last_cron: null, cron_state_available: false, scheduler_stale: null });
  });

  it("the redacted member view carries no health at all", async () => {
    db.seed("integration_deliveries", [delivery("d1", "dead", { last_error: "boom" })]);
    requireAuthMock.mockResolvedValue(admin({ role: "member" }));
    const { text } = await get();
    expect(text).not.toContain("health");
    expect(text).not.toContain("boom");
  });
});

describe("POST /api/integrations/connectors — webhook mode requires an Encrypt Key", () => {
  const withoutKey = { ...validBody, encrypt_key: undefined };

  it("422s a webhook connector (the default mode) without one, naming the field and why", async () => {
    const res = await post(withoutKey);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; fields?: { field: string; message: string }[] };
    expect(body.fields?.some((f) => f.field === "encrypt_key" && /webhook mode/i.test(f.message))).toBe(true);
    expect(db.rows("integration_connectors")).toHaveLength(0);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("422s an explicit webhook connector with a null or empty key too", async () => {
    expect((await post({ ...withoutKey, mode: "webhook", encrypt_key: null })).status).toBe(422);
    expect((await post({ ...withoutKey, mode: "webhook", encrypt_key: "" })).status).toBe(422);
  });

  it("accepts a webhook connector that has one, and stores it", async () => {
    expect((await post(validBody)).status).toBe(201);
    expect(decryptSecrets(db.rows("integration_connectors")[0].secret_enc as string).encryptKey).toBe("valid-encrypt-key-0004");
  });

  it("lets a long-connection connector omit it (no public URL to protect)", async () => {
    const res = await post({ ...withoutKey, mode: "long_connection" });
    expect(res.status).toBe(201);
    expect(decryptSecrets(db.rows("integration_connectors")[0].secret_enc as string).encryptKey).toBeNull();
  });
});

describe("POST /api/integrations/connectors — the audit row is member-readable, so ids are masked", () => {
  it("masks the app id and the digest chat id and carries no tenant", async () => {
    await post({ ...validBody, digest: { enabled: true, chat_id: "oc_privateroom99", weekday: 2 } });
    const audit = writeAuditMock.mock.calls[0][0] as { after: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const text = JSON.stringify(audit);
    expect(text).not.toContain("cli_a1b2c3");
    expect(text).not.toContain("oc_privateroom99");
    expect(audit.after.app_id).toMatch(/…/);
    expect(audit.after.digest).toMatchObject({ enabled: true, weekday: 2 });
    expect(audit.after.digest.chat_id).toMatch(/…/);
    expect(text).not.toMatch(/tenant_key/);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
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

import { decryptSecrets, encryptSecrets } from "@/lib/integrations/secrets";
import {
  APP_SECRET,
  CONNECTOR_ID,
  FakeDb,
  OTHER_WS,
  TEST_ENCRYPTION_KEY,
  VERIFICATION_TOKEN,
  WS,
  connectorRow,
  ids,
  linkIdentity,
  seedWorkspace,
} from "@/lib/integrations/test-support";
import { DELETE, PATCH } from "./route";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
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

const patch = (body: unknown, id = CONNECTOR_ID) =>
  PATCH(
    new NextRequest(`http://localhost:3000/api/integrations/connectors/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    params(id),
  );
const del = (id = CONNECTOR_ID) =>
  DELETE(new NextRequest(`http://localhost:3000/api/integrations/connectors/${id}`, { method: "DELETE" }), params(id));

let db: FakeDb;
const connectorInDb = () => db.rows("integration_connectors")[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const lastAudit = () => writeAuditMock.mock.calls.at(-1)![0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

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
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("PATCH /api/integrations/connectors/[id]", () => {
  it("renames and pauses (the kill switch) with one audit row holding before/after public views", async () => {
    const res = await patch({ name: "Renamed", status: "paused" });
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ name: "Renamed", status: "paused" });
    expect(connectorInDb()).toMatchObject({ name: "Renamed", status: "paused" });
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(lastAudit()).toMatchObject({
      action: "integration.connector.update",
      targetId: CONNECTOR_ID,
      before: { status: "active", name: "Team Lark" },
      after: { status: "paused", name: "Renamed", secrets_changed: [], relay_secret_rotated: false },
    });
  });

  it("can resume a paused connector", async () => {
    connectorInDb().status = "paused";
    expect((await patch({ status: "active" })).status).toBe(200);
    expect(connectorInDb().status).toBe("active");
  });

  it("shallow-merges config: a partial digest change keeps the rest", async () => {
    await patch({ digest: { enabled: true, chat_id: "oc_team1" } });
    expect(connectorInDb().config).toMatchObject({
      region: "lark",
      appId: "cli_a1b2c3",
      digest: { enabled: true, chatId: "oc_team1", weekday: 1 },
      approvals: { enabled: true },
    });
    await patch({ digest: { weekday: 4 }, approvals: { enabled: false } });
    expect(connectorInDb().config).toMatchObject({
      digest: { enabled: true, chatId: "oc_team1", weekday: 4 },
      approvals: { enabled: false },
    });
    await patch({ digest: { enabled: false, chat_id: null } });
    expect(connectorInDb().config.digest).toEqual({ enabled: false, chatId: null, weekday: 4 });
  });

  it("replaces only the credentials supplied, never echoes them, and audits WHICH changed (not their values)", async () => {
    const res = await patch({ app_secret: "brand-new-app-secret-77" });
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(decryptSecrets(connectorInDb().secret_enc)).toEqual({
      appSecret: "brand-new-app-secret-77",
      verificationToken: VERIFICATION_TOKEN, // untouched
      encryptKey: null,
    });
    expect(text).not.toContain("brand-new-app-secret-77");
    expect(lastAudit().after.secrets_changed).toEqual(["app_secret"]);
    expect(JSON.stringify(lastAudit())).not.toContain("brand-new-app-secret-77");
    expect(JSON.stringify(lastAudit())).not.toContain(APP_SECRET);
  });

  it("sets and clears the encrypt key", async () => {
    await patch({ encrypt_key: "ek-set-0001" });
    expect(decryptSecrets(connectorInDb().secret_enc).encryptKey).toBe("ek-set-0001");
    expect(((await (await patch({ encrypt_key: "ek-set-0001" })).json()) as { data: { has_encrypt_key: boolean } }).data.has_encrypt_key).toBe(true);
    await patch({ encrypt_key: null });
    expect(decryptSecrets(connectorInDb().secret_enc).encryptKey).toBeNull();
  });

  it("rotates the relay secret: new one returned once, old one dead, only the hash stored", async () => {
    const oldHash = connectorInDb().relay_secret_hash;
    const res = await patch({ rotate_relay_secret: true });
    const text = await res.text();
    const relay = (JSON.parse(text) as { data: { relay_secret: string } }).data.relay_secret;

    expect(relay).toMatch(/^npr_/);
    expect(connectorInDb().relay_secret_hash).toBe(sha256(relay));
    expect(connectorInDb().relay_secret_hash).not.toBe(oldHash);
    expect(JSON.stringify(db.tables)).not.toContain(relay);
    expect(lastAudit().after.relay_secret_rotated).toBe(true);
    expect(JSON.stringify(lastAudit())).not.toContain(relay);

    // an ordinary update never returns a relay secret
    const plain = (await (await patch({ name: "x" })).json()) as { data: Record<string, unknown> };
    expect(plain.data.relay_secret).toBeUndefined();
  });

  it("recovers from unreadable stored credentials only when both are re-supplied", async () => {
    connectorInDb().secret_enc = encryptSecrets({ appSecret: "a", verificationToken: "b" });
    vi.stubEnv("NOPM_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64")); // key rotated: blob unreadable

    const partial = await patch({ app_secret: "only-one-0001" });
    expect(partial.status).toBe(422);
    expect(((await partial.json()) as { code: string }).code).toBe("secrets_unreadable");

    const full = await patch({ app_secret: "fresh-app-secret", verification_token: "fresh-verification" });
    expect(full.status).toBe(200);
    expect(decryptSecrets(connectorInDb().secret_enc)).toMatchObject({ appSecret: "fresh-app-secret", verificationToken: "fresh-verification" });
  });

  it.each([
    ["an empty body", {}],
    ["revoking via PATCH", { status: "revoked" }],
    ["an unknown status", { status: "banana" }],
    ["a bad app id", { app_id: "no spaces allowed" }],
    ["digest enabled without a chat", { digest: { enabled: true } }],
    ["an empty secret", { app_secret: "" }],
  ])("rejects %s with 422 and changes nothing", async (_label, body) => {
    const before = JSON.stringify(connectorInDb());
    expect((await patch(body)).status).toBe(422);
    expect(JSON.stringify(connectorInDb())).toBe(before);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("refuses to edit a revoked connector", async () => {
    connectorInDb().status = "revoked";
    const res = await patch({ name: "nope" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("connector_revoked");
  });

  it("404s for an unknown connector and for another workspace's connector", async () => {
    expect((await patch({ name: "x" }, "no-such-id")).status).toBe(404);
    db.seed("integration_connectors", [connectorRow({ id: "foreign", workspace_id: OTHER_WS })]);
    expect((await patch({ name: "hijack" }, "foreign")).status).toBe(404);
    expect(db.rows("integration_connectors").find((c) => c.id === "foreign")!.name).toBe("Team Lark");
  });

  it("is admin-only", async () => {
    for (const actor of [admin({ role: "manager" }), admin({ role: "member" }), { type: "token", id: "t", label: "t", workspaceId: WS, scopes: ["*"] } as Actor]) {
      requireAuthMock.mockResolvedValue(actor);
      expect((await patch({ name: "x" })).status).toBe(403);
    }
    expect(connectorInDb().name).toBe("Team Lark");
    expect(writeAuditMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/integrations/connectors/[id] (revoke)", () => {
  it("revokes the connector, unlinks every identity, supersedes queued deliveries, drops unused link codes — one audit row", async () => {
    linkIdentity(db, ids.manager, "ou_max");
    linkIdentity(db, ids.manager2, "ou_mia");
    db.seed("integration_deliveries", [
      { id: "d-pending", workspace_id: WS, connector_id: CONNECTOR_ID, kind: "digest", status: "pending" },
      { id: "d-retry", workspace_id: WS, connector_id: CONNECTOR_ID, kind: "bot_reply", status: "retry" },
      { id: "d-sent", workspace_id: WS, connector_id: CONNECTOR_ID, kind: "digest", status: "sent" },
    ]);
    db.seed("identity_link_codes", [
      { id: "code-open", workspace_id: WS, connector_id: CONNECTOR_ID, profile_id: ids.manager, code_hash: "h1", used_at: null },
      { id: "code-used", workspace_id: WS, connector_id: CONNECTOR_ID, profile_id: ids.manager2, code_hash: "h2", used_at: "2026-10-01T00:00:00.000Z" },
    ]);

    const res = await del();
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ status: "revoked" });
    expect(connectorInDb()).toMatchObject({ status: "revoked" });
    expect(connectorInDb().revoked_at).toEqual(expect.any(String));
    expect(db.rows("external_identities").every((i) => i.revoked_at !== null)).toBe(true);
    const states = Object.fromEntries(db.rows("integration_deliveries").map((d) => [d.id as string, d.status]));
    expect(states).toEqual({ "d-pending": "superseded", "d-retry": "superseded", "d-sent": "sent" });
    expect(db.rows("identity_link_codes").map((c) => c.id)).toEqual(["code-used"]);

    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(lastAudit()).toMatchObject({
      action: "integration.connector.revoke",
      targetId: CONNECTOR_ID,
      before: { status: "active" },
      after: { status: "revoked", identities_revoked: 2, deliveries_superseded: 2 },
    });
  });

  it("leaves another workspace's data untouched", async () => {
    db.seed("integration_connectors", [connectorRow({ id: "foreign", workspace_id: OTHER_WS })]);
    db.seed("external_identities", [
      { id: "fi", workspace_id: OTHER_WS, connector_id: "foreign", profile_id: "p", external_tenant: "t", external_user_id: "u", revoked_at: null },
    ]);
    await del();
    expect(db.rows("integration_connectors").find((c) => c.id === "foreign")!.status).toBe("active");
    expect(db.rows("external_identities").find((i) => i.id === "fi")!.revoked_at).toBeNull();
    expect((await del("foreign")).status).toBe(404);
  });

  it("cannot be revoked twice", async () => {
    expect((await del()).status).toBe(200);
    const again = await del();
    expect(again.status).toBe(422);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
  });

  it("is admin-only and 404s for unknown ids", async () => {
    requireAuthMock.mockResolvedValue(admin({ role: "manager" }));
    expect((await del()).status).toBe(403);
    expect(connectorInDb().status).toBe("active");
    requireAuthMock.mockResolvedValue(admin());
    expect((await del("nope")).status).toBe(404);
  });
});

describe("PATCH clear_tenant_pin", () => {
  it("lets an admin clear the pinned Lark tenant (audited), without touching anything else", async () => {
    connectorInDb().tenant_key = "tenant-A";
    const before = (await (await patch({ name: "Team Lark" })).json()) as { data: { tenant_pinned: boolean } };
    expect(before.data.tenant_pinned).toBe(true); // the admin view says it is pinned

    const res = await patch({ clear_tenant_pin: true });
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(connectorInDb().tenant_key).toBeNull();
    expect(body.data.tenant_pinned).toBe(false);
    expect(connectorInDb()).toMatchObject({ name: "Team Lark", status: "active" });
    expect(lastAudit()).toMatchObject({
      action: "integration.connector.update",
      before: { tenant_pinned: true },
      after: { tenant_pinned: false, tenant_pin_cleared: true },
    });
    // the tenant key itself is never put in the audit row
    expect(JSON.stringify(lastAudit())).not.toContain("tenant-A");
  });

  it("an ordinary update leaves the pin alone", async () => {
    connectorInDb().tenant_key = "tenant-A";
    await patch({ name: "Renamed" });
    expect(connectorInDb().tenant_key).toBe("tenant-A");
    expect(lastAudit().after.tenant_pin_cleared).toBe(false);
  });

  it("is admin-only like every other mutation", async () => {
    connectorInDb().tenant_key = "tenant-A";
    requireAuthMock.mockResolvedValue(admin({ role: "manager" }));
    expect((await patch({ clear_tenant_pin: true })).status).toBe(403);
    expect(connectorInDb().tenant_key).toBe("tenant-A");
  });
});

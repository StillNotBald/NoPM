/**
 * R-164 (wave 5, W5-B): the Lark connector, the GitHub connector and the identity link each change their rows
 * AND write their audit row in one database call. Here the in-memory mirrors of migration 0109 are driven
 * through the real route handlers: when the audit write fails nothing is kept (no orphan connector, the old
 * rules, the old status), and no secret ever reaches an audit payload. The SQL is proved by
 * scripts/local-db/probe-atomic-security.mjs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { CONNECTOR_ID, FakeDb, TEST_ENCRYPTION_KEY, WS, ids, seedWorkspace } from "@/lib/integrations/test-support";
import { DELETE as ghDelete, PATCH as ghPatch, POST as ghPost } from "./github/connector/route";
import { PATCH as larkPatch } from "./connectors/[id]/route";
import { POST as larkPost } from "./connectors/route";

const admin = (): Actor => ({ type: "user", id: ids.admin, label: "Ada Admin", workspaceId: WS, role: "admin", principalId: ids.admin, channel: "api" });

const send = (handler: typeof ghPost, url: string, method: string, body?: unknown, params: Record<string, string> = {}) =>
  handler(
    new NextRequest(url, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { params: Promise.resolve(params) } as never,
  );

const GH = "http://localhost:3000/api/integrations/github/connector";
const LARK = "http://localhost:3000/api/integrations/connectors";
const larkBody = {
  name: "Acme Lark",
  region: "lark",
  app_id: "cli_a1b2c3d4e5f6g7",
  app_secret: "the-app-secret-0001",
  verification_token: "the-verification-token-0002",
  encrypt_key: "valid-encrypt-key-0004",
  digest: { enabled: true, chat_id: "oc_0123456789abcdef", weekday: 3 },
};

let db: FakeDb;

/** The audit writer fails for these actions only (the second row of a two-row transaction, say). */
const failAuditFor = (...actions: string[]) =>
  writeAuditMock.mockImplementation(async (input) => {
    if (actions.includes(String(input.action))) throw new Error("audit down");
  });

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue(admin());
  db = new FakeDb();
  db.seed("workspaces", [{ id: WS, name: "Acme PMO", work_event_rules: { pr_opened: "started", pr_merged: "in_review", pr_closed: null, deploy_success: null, deploy_failure: null } }]);
  state.db = db;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Lark connector create (R-164a)", () => {
  it("is one database call; the audit row carries the masked view and presence flags, never a secret, hash or raw id", async () => {
    const res = await send(larkPost, LARK, "POST", larkBody);
    expect(res.status).toBe(201);
    const body = (await res.json()).data;
    expect(db.rows("integration_connectors")).toHaveLength(1);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const audit = writeAuditMock.mock.calls[0][0] as { action: string; before: unknown; after: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(audit.action).toBe("integration.connector.create");
    expect(audit.before).toBeNull();
    expect(audit.after).toMatchObject({ kind: "lark", name: "Acme Lark", has_app_secret: true, has_verification_token: true, has_encrypt_key: true, has_relay_secret: true, tenant_pinned: false });
    expect(audit.after.app_id).toBe("cli_a1…f6g7");
    expect(audit.after.digest.chat_id).toBe("oc_012…cdef");
    const text = JSON.stringify(audit);
    for (const secret of ["the-app-secret-0001", "the-verification-token-0002", "valid-encrypt-key-0004", body.relay_secret, "cli_a1b2c3d4e5f6g7", "oc_0123456789abcdef"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/secret_enc|relay_secret_hash/);
  });

  it("leaves NO connector behind when the audit row cannot be written (no orphan row)", async () => {
    failAuditFor("integration.connector.create");
    const res = await send(larkPost, LARK, "POST", larkBody);
    expect(res.status).toBe(500);
    expect(db.rows("integration_connectors")).toHaveLength(0);
    // and the slot is still free: the same request works once the audit writer is back
    writeAuditMock.mockResolvedValue(undefined);
    expect((await send(larkPost, LARK, "POST", larkBody)).status).toBe(201);
  });
});

describe("Lark connector update (R-164a)", () => {
  const params = { id: CONNECTOR_ID };

  it("keeps the old name, status and secrets when the audit row cannot be written", async () => {
    seedWorkspace(db);
    const before = structuredClone(db.rows("integration_connectors")[0]);
    failAuditFor("integration.connector.update");
    const res = await send(larkPatch, `${LARK}/${CONNECTOR_ID}`, "PATCH", { name: "Renamed", status: "paused", app_secret: "a-brand-new-app-secret-77", encrypt_key: "valid-encrypt-key-0004" }, params);
    expect(res.status).toBe(500);
    expect(db.rows("integration_connectors")[0]).toEqual(before);
  });

  it("audits WHICH secrets changed and the masked view, and never a value", async () => {
    seedWorkspace(db);
    const res = await send(larkPatch, `${LARK}/${CONNECTOR_ID}`, "PATCH", { name: "Renamed", app_secret: "a-brand-new-app-secret-77", encrypt_key: "valid-encrypt-key-0004" }, params);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const audit = writeAuditMock.mock.calls[0][0] as { before: Record<string, unknown>; after: Record<string, unknown> };
    expect(audit.after).toMatchObject({ name: "Renamed", secrets_changed: ["app_secret", "encrypt_key"], relay_secret_rotated: false });
    expect(JSON.stringify(audit)).not.toContain("a-brand-new-app-secret-77");
    expect(JSON.stringify(audit)).not.toContain("valid-encrypt-key-0004");
    expect(JSON.stringify(audit)).not.toMatch(/secret_enc|relay_secret_hash/);
  });

  it("refuses a revoked connector (422) and answers 404 for an unknown one", async () => {
    seedWorkspace(db);
    db.rows("integration_connectors")[0].status = "revoked";
    expect((await send(larkPatch, `${LARK}/${CONNECTOR_ID}`, "PATCH", { name: "X" }, params)).status).toBe(422);
    expect((await send(larkPatch, `${LARK}/nope`, "PATCH", { name: "X" }, { id: "nope" })).status).toBe(404);
  });
});

describe("GitHub connector (R-164a)", () => {
  it("create: no connector row without its audit row, and no secret in the payload", async () => {
    failAuditFor("integration.connector.create");
    expect((await send(ghPost, GH, "POST", {})).status).toBe(500);
    expect(db.rows("integration_connectors")).toHaveLength(0);
    writeAuditMock.mockResolvedValue(undefined);
    const res = await send(ghPost, GH, "POST", {});
    const secret = (await res.json()).data.webhook_secret as string;
    expect(JSON.stringify(writeAuditMock.mock.calls.map((c) => c[0]))).not.toContain(secret);
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({ action: "integration.connector.create", after: { kind: "github", name: "GitHub", status: "active" } });
  });

  it("PATCH status + rules: both audit rows, or neither the connector change nor the new rules", async () => {
    await send(ghPost, GH, "POST", {});
    writeAuditMock.mockClear();
    const rulesBefore = structuredClone(db.rows("workspaces")[0].work_event_rules);

    failAuditFor("work_event_rules.update"); // the SECOND row of the transaction fails
    const failed = await send(ghPatch, GH, "PATCH", { status: "paused", rules: { pr_merged: "started" } });
    expect(failed.status).toBe(500);
    expect(db.rows("integration_connectors")[0].status).toBe("active");
    expect(db.rows("workspaces")[0].work_event_rules).toEqual(rulesBefore);

    writeAuditMock.mockReset();
    writeAuditMock.mockResolvedValue(undefined);
    const okRes = await send(ghPatch, GH, "PATCH", { status: "paused", rules: { pr_merged: "started" } });
    expect(okRes.status).toBe(200);
    expect(db.rows("integration_connectors")[0].status).toBe("paused");
    expect((db.rows("workspaces")[0].work_event_rules as Record<string, unknown>).pr_merged).toBe("started");
    expect(writeAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action)).toEqual(["integration.connector.update", "work_event_rules.update"]);
    expect(writeAuditMock.mock.calls[1][0]).toMatchObject({ targetType: "workspace", targetId: WS, before: rulesBefore });
  });

  it("PATCH rotate: the new secret is returned once and is not in the audit row", async () => {
    await send(ghPost, GH, "POST", {});
    writeAuditMock.mockClear();
    const res = await send(ghPatch, GH, "PATCH", { rotate_secret: true });
    const secret = (await res.json()).data.webhook_secret as string;
    expect(secret).toMatch(/^npg_/);
    expect(JSON.stringify(writeAuditMock.mock.calls)).not.toContain(secret);
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({ after: { kind: "github", status: "active", secret_rotated: true } });
  });

  it("DELETE: the connector stays live when the revoke audit row cannot be written", async () => {
    await send(ghPost, GH, "POST", {});
    failAuditFor("integration.connector.revoke");
    expect((await send(ghDelete, GH, "DELETE")).status).toBe(500);
    expect(db.rows("integration_connectors")[0]).toMatchObject({ status: "active", revoked_at: null });
    writeAuditMock.mockResolvedValue(undefined);
    expect((await send(ghDelete, GH, "DELETE")).status).toBe(200);
    expect(db.rows("integration_connectors")[0].status).toBe("revoked");
    expect((await send(ghDelete, GH, "DELETE")).status).toBe(404); // no live connector any more
  });
});

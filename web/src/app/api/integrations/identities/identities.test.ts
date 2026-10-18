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

import { lookupIdentity } from "@/lib/integrations/identity";
import {
  CONNECTOR_ID,
  FakeDb,
  OTHER_WS,
  TEST_ENCRYPTION_KEY,
  WS,
  connectorRow,
  ids,
  linkIdentity,
  seedWorkspace,
} from "@/lib/integrations/test-support";
import { GET } from "./route";
import { POST as mintCode } from "./link-code/route";
import { DELETE as unlink } from "./[id]/route";

const NO_PARAMS = { params: Promise.resolve({}) };
const user = (id: string, role: string, over: Partial<Actor> = {}): Actor => ({
  type: "user",
  id,
  label: role,
  workspaceId: WS,
  role,
  principalId: id,
  ...over,
});
const token: Actor = { type: "token", id: "tok", label: "agent", workspaceId: WS, scopes: ["*"], principalId: ids.admin };

const list = (query = "") => GET(new NextRequest(`http://localhost:3000/api/integrations/identities${query}`), NO_PARAMS);
const mint = () => mintCode(new NextRequest("http://localhost:3000/api/integrations/identities/link-code", { method: "POST" }), NO_PARAMS);
const del = (id: string) =>
  unlink(new NextRequest(`http://localhost:3000/api/integrations/identities/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });

let db: FakeDb;
// Unlink is written by nopm_mutate_audited (migration 0103): its audit row lands in the table, not in writeAudit.
const auditRows = () => db.rows("audit_log") as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
const lastAudit = () => writeAuditMock.mock.calls.at(-1)![0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  vi.spyOn(console, "error").mockImplementation(() => {});
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue(user(ids.manager, "manager"));
  db = new FakeDb();
  state.db = db;
  seedWorkspace(db);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/integrations/identities", () => {
  beforeEach(() => {
    linkIdentity(db, ids.manager, "ou_1234567890abcdef");
    linkIdentity(db, ids.manager2, "ou_zzzzzzzzzzzzzzzz");
    db.seed("external_identities", [
      { id: "foreign", workspace_id: OTHER_WS, connector_id: "x", provider: "lark", external_tenant: "t", external_user_id: "ou_foreign_user", profile_id: "pf", linked_at: "2026-10-03T00:00:00.000Z", revoked_at: null },
    ]);
  });

  it("a member sees only their own link, with the platform id masked", async () => {
    const text = await (await list()).text();
    const body = JSON.parse(text) as { data: { profile_id: string; external_user_hint: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.data[0]).toMatchObject({ profile_id: ids.manager, external_user_hint: "ou_123…cdef" });
    expect(text).not.toContain("ou_1234567890abcdef");
  });

  it("an admin sees every link in the workspace (never another workspace's), or just their own with ?mine=1", async () => {
    requireAuthMock.mockResolvedValue(user(ids.admin, "admin"));
    const all = (await (await list()).json()) as { data: { profile_id: string }[] };
    expect(all.data.map((r) => r.profile_id).sort()).toEqual([ids.manager, ids.manager2].sort());
    const mine = (await (await list("?mine=1")).json()) as { data: unknown[] };
    expect(mine.data).toHaveLength(0);
  });

  it("does not list unlinked accounts", async () => {
    db.rows("external_identities")[0].revoked_at = "2026-10-10T00:00:00.000Z";
    expect(((await (await list()).json()) as { data: unknown[] }).data).toHaveLength(0);
  });

  it("is for signed-in users: a token gets 403", async () => {
    requireAuthMock.mockResolvedValue(token);
    expect((await list()).status).toBe(403);
  });
});

describe("POST /api/integrations/identities/link-code", () => {
  it("mints a one-time code for the signed-in member: shown once, stored hashed, audited without the code", async () => {
    const res = await mint();
    const text = await res.text();
    const body = JSON.parse(text) as { data: { code: string; expires_at: string; connector_id: string; instructions: string } };

    expect(res.status).toBe(201);
    expect(body.data.code).toMatch(/^NPL-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(body.data.connector_id).toBe(CONNECTOR_ID);
    expect(body.data.instructions).toContain(body.data.code);

    const stored = db.rows("identity_link_codes");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ workspace_id: WS, connector_id: CONNECTOR_ID, profile_id: ids.manager, used_at: null });
    expect(stored[0].code_hash).toBe(createHash("sha256").update(body.data.code).digest("hex"));
    expect(JSON.stringify(db.tables)).not.toContain(body.data.code);

    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(lastAudit()).toMatchObject({ workspaceId: WS, action: "integration.identity.code", targetId: CONNECTOR_ID });
    expect(JSON.stringify(lastAudit())).not.toContain(body.data.code);
  });

  it("minting again replaces the previous code", async () => {
    const first = ((await (await mint()).json()) as { data: { code: string } }).data.code;
    const second = ((await (await mint()).json()) as { data: { code: string } }).data.code;
    expect(first).not.toBe(second);
    expect(db.rows("identity_link_codes")).toHaveLength(1);
  });

  it("any signed-in member may link, viewers included", async () => {
    requireAuthMock.mockResolvedValue(user(ids.viewer, "viewer"));
    expect((await mint()).status).toBe(201);
  });

  it("needs a session — a token has no profile to link", async () => {
    requireAuthMock.mockResolvedValue(token);
    expect((await mint()).status).toBe(403);
    expect(db.rows("identity_link_codes")).toHaveLength(0);
  });

  it("a PAUSED connector says so and who can fix it (D-ACC-16)", async () => {
    db.rows("integration_connectors")[0].status = "paused";
    const res = await mint();
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("connector_paused");
    expect(body.error).toBe("The Lark connection is paused. Ask an admin to resume it.");
    expect(db.rows("identity_link_codes")).toHaveLength(0);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("422s when the workspace has no active connector (revoked or absent)", async () => {
    db.rows("integration_connectors")[0].status = "revoked";
    const res = await mint();
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("no_connector");
    expect(db.rows("identity_link_codes")).toHaveLength(0);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("never uses another workspace's connector", async () => {
    db.rows("integration_connectors")[0].workspace_id = OTHER_WS;
    expect((await mint()).status).toBe(422);
  });
});

describe("DELETE /api/integrations/identities/[id]", () => {
  let mineId: string;
  let herId: string;
  beforeEach(() => {
    mineId = linkIdentity(db, ids.manager, "ou_1234567890abcdef").id as string;
    herId = linkIdentity(db, ids.manager2, "ou_zzzzzzzzzzzzzzzz").id as string;
  });

  it("the owner unlinks their own account — soft revoke, one audit row, masked reference", async () => {
    const res = await del(mineId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: mineId, revoked: true } });
    expect(db.rows("external_identities").find((r) => r.id === mineId)!.revoked_at).not.toBeNull();

    expect(auditRows()).toHaveLength(1);
    expect(writeAuditMock).not.toHaveBeenCalled();
    expect(auditRows()[0]).toMatchObject({
      action: "integration.identity.unlink",
      target_type: "external_identity",
      target_id: mineId,
      before: { connector_id: CONNECTOR_ID, profile_id: ids.manager },
      after: { revoked: true, unlinked_by_owner: true },
    });
    expect(JSON.stringify(auditRows()[0])).not.toContain("ou_1234567890abcdef");
    // a click from a card they still hold now resolves to "unlinked"
    expect(await lookupIdentity(connectorRow(), "tenant-1", "ou_1234567890abcdef")).toBeNull();
  });

  it("another member cannot unlink someone else's account", async () => {
    expect((await del(herId)).status).toBe(403);
    expect(db.rows("external_identities").find((r) => r.id === herId)!.revoked_at).toBeNull();
    expect(writeAuditMock).not.toHaveBeenCalled();
    expect(auditRows()).toHaveLength(0);
  });

  it("an admin can unlink anyone's (e.g. a leaver)", async () => {
    requireAuthMock.mockResolvedValue(user(ids.admin, "admin"));
    expect((await del(herId)).status).toBe(200);
    expect(auditRows().at(-1)!.after).toMatchObject({ unlinked_by_owner: false });
  });

  it("404s for unknown, already-unlinked or other-workspace links", async () => {
    expect((await del("nope")).status).toBe(404);
    await del(mineId);
    expect((await del(mineId)).status).toBe(404);
    // the lost second unlink wrote no second audit row
    expect(auditRows()).toHaveLength(1);
    db.seed("external_identities", [
      { id: "foreign", workspace_id: OTHER_WS, connector_id: "x", provider: "lark", external_tenant: "t", external_user_id: "u", profile_id: ids.manager, linked_at: "2026-10-03T00:00:00.000Z", revoked_at: null },
    ]);
    requireAuthMock.mockResolvedValue(user(ids.admin, "admin"));
    expect((await del("foreign")).status).toBe(404);
    expect(db.rows("external_identities").find((r) => r.id === "foreign")!.revoked_at).toBeNull();
  });

  it("needs a session", async () => {
    requireAuthMock.mockResolvedValue(token);
    expect((await del(mineId)).status).toBe(403);
  });
});

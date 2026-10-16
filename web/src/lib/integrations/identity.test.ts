import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { writeAuditMock } = vi.hoisted(() => ({
  writeAuditMock: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/audit/write", () => ({ writeAudit: writeAuditMock }));

import {
  LINK_CODE_TTL_MS,
  consumeLinkCode,
  externalActorRef,
  generateLinkCode,
  hashLinkCode,
  listIdentities,
  lookupIdentity,
  maskExternalId,
  mintLinkCode,
  normalizeLinkCode,
} from "./identity";
import {
  CONNECTOR_ID,
  FakeDb,
  OTHER_WS,
  TEST_ENCRYPTION_KEY,
  WS,
  ids,
  linkIdentity,
  seedWorkspace,
} from "./test-support";
import type { ConnectorRow } from "./types";

let db: FakeDb;
let connector: ConnectorRow;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T09:00:00.000Z"));
  vi.stubEnv("NOPM_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  db = new FakeDb();
  state.db = db;
  connector = seedWorkspace(db);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const link = (over: Partial<Parameters<typeof consumeLinkCode>[0]> & { rawCode: string }) =>
  consumeLinkCode({
    connector,
    externalTenant: "tenant-1",
    externalUserId: "ou_alice",
    externalEventId: "evt-1",
    ...over,
  });

describe("link code format", () => {
  it("generates NPL-XXXX-XXXX from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateLinkCode()).toMatch(/^NPL-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
    const unique = new Set(Array.from({ length: 200 }, generateLinkCode));
    expect(unique.size).toBe(200);
  });

  it("normalises what a person types (case, dashes, spaces) and rejects junk", () => {
    expect(normalizeLinkCode("npl-abcd-efgh")).toBe("NPL-ABCD-EFGH");
    expect(normalizeLinkCode("  NPLABCDEFGH ")).toBe("NPL-ABCD-EFGH");
    expect(normalizeLinkCode("NPL-ABCD EFGH")).toBe("NPL-ABCD-EFGH");
    expect(normalizeLinkCode("NPL-0000-1111")).toBeNull(); // 0/1/I/O are not in the alphabet
    expect(normalizeLinkCode("NPL-ABC-DEFGH")).toBeNull();
    expect(normalizeLinkCode("hello")).toBeNull();
    expect(normalizeLinkCode(undefined)).toBeNull();
    expect(normalizeLinkCode(null)).toBeNull();
  });

  it("hashes with sha-256 and masks platform ids", () => {
    expect(hashLinkCode("NPL-ABCD-EFGH")).toBe(createHash("sha256").update("NPL-ABCD-EFGH").digest("hex"));
    expect(maskExternalId("ou_1234567890abcdef")).toBe("ou_123…cdef");
    expect(maskExternalId("short")).toBe("sh…");
    expect(externalActorRef("lark", "t1", "ou_x")).toBe("lark:t1:ou_x");
  });
});

describe("mintLinkCode", () => {
  it("stores only the hash, expires in 10 minutes, and replaces the previous unused code", async () => {
    const first = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    expect(first.code).toMatch(/^NPL-/);
    expect(new Date(first.expiresAt).getTime() - Date.now()).toBe(LINK_CODE_TTL_MS);
    expect(JSON.stringify(db.rows("identity_link_codes"))).not.toContain(first.code);
    expect(db.rows("identity_link_codes")[0].code_hash).toBe(hashLinkCode(first.code));

    const second = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    expect(db.rows("identity_link_codes")).toHaveLength(1);
    expect(db.rows("identity_link_codes")[0].code_hash).toBe(hashLinkCode(second.code));
    // the replaced code is dead
    expect((await link({ rawCode: first.code })).status).toBe("invalid_code");
  });

  it("keeps different people's codes independent", async () => {
    await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    await mintLinkCode({ workspaceId: WS, profileId: ids.manager2, connectorId: CONNECTOR_ID });
    expect(db.rows("identity_link_codes")).toHaveLength(2);
  });
});

describe("consumeLinkCode", () => {
  it("links the verified platform user to the code owner and writes ONE audit row as that person on channel lark", async () => {
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });

    const outcome = await link({ rawCode: code.toLowerCase(), displayName: "Alice (Lark)", externalUnionId: "on_1" });

    expect(outcome).toEqual({ status: "linked", profileLabel: "Max Manager", alreadyLinked: false });
    const identities = db.rows("external_identities");
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      workspace_id: WS,
      connector_id: CONNECTOR_ID,
      profile_id: ids.manager,
      external_tenant: "tenant-1",
      external_user_id: "ou_alice",
      external_union_id: "on_1",
      display_name: "Alice (Lark)",
      revoked_at: null,
    });

    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const audit = writeAuditMock.mock.calls[0][0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(audit).toMatchObject({
      workspaceId: WS,
      action: "integration.identity.link",
      targetType: "external_identity",
      targetId: identities[0].id,
    });
    expect(audit.actor).toMatchObject({
      type: "user",
      id: ids.manager,
      principalId: ids.manager,
      channel: "lark",
      viaConnectorId: CONNECTOR_ID,
      externalEventId: "evt-1",
      externalActorRef: "lark:tenant-1:ou_alice",
    });
    // no code anywhere in the audit payload
    expect(JSON.stringify(audit)).not.toContain(code);
  });

  it("a code is single use", async () => {
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    expect((await link({ rawCode: code })).status).toBe("linked");
    expect((await link({ rawCode: code, externalUserId: "ou_mallory" })).status).toBe("already_used");
    expect(db.rows("external_identities")).toHaveLength(1);
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown, malformed and cross-connector codes without creating a link", async () => {
    expect((await link({ rawCode: "NPL-AAAA-BBBB" })).status).toBe("invalid_code");
    expect((await link({ rawCode: "not a code" })).status).toBe("invalid_code");

    // a code minted for ANOTHER workspace's connector must not work here
    const other = await mintLinkCode({ workspaceId: OTHER_WS, profileId: ids.manager, connectorId: "other-connector" });
    expect((await link({ rawCode: other.code })).status).toBe("invalid_code");
    expect(db.rows("external_identities")).toHaveLength(0);
  });

  it("rejects an expired code", async () => {
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    vi.setSystemTime(new Date(Date.now() + LINK_CODE_TTL_MS + 1000));
    expect((await link({ rawCode: code })).status).toBe("expired");
    expect(db.rows("external_identities")).toHaveLength(0);
  });

  it("refuses while the connector is paused or revoked", async () => {
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    const out = await consumeLinkCode({
      connector: { ...connector, status: "paused" },
      rawCode: code,
      externalTenant: "tenant-1",
      externalUserId: "ou_alice",
    });
    expect(out.status).toBe("paused");
    expect(db.rows("identity_link_codes")[0].used_at).toBeNull(); // code not burned
  });

  it("refuses to steal a platform account already linked to someone else, and does not burn the code", async () => {
    linkIdentity(db, ids.manager2, "ou_alice");
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    const out = await link({ rawCode: code });
    expect(out.status).toBe("conflict");
    expect(db.rows("identity_link_codes")[0].used_at).toBeNull();
    expect(db.rows("external_identities").filter((r) => r.revoked_at == null)).toHaveLength(1);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("is idempotent when the same person links the same platform account again (no second audit row)", async () => {
    linkIdentity(db, ids.manager, "ou_alice");
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    expect(await link({ rawCode: code })).toEqual({ status: "linked", profileLabel: "Max Manager", alreadyLinked: true });
    expect(db.rows("external_identities")).toHaveLength(1);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("keeps one active link per profile: a new platform account replaces the old one", async () => {
    linkIdentity(db, ids.manager, "ou_old");
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    expect((await link({ rawCode: code, externalUserId: "ou_new" })).status).toBe("linked");

    const active = db.rows("external_identities").filter((r) => r.revoked_at == null);
    expect(active).toHaveLength(1);
    expect(active[0].external_user_id).toBe("ou_new");
    expect(db.rows("external_identities").find((r) => r.external_user_id === "ou_old")?.revoked_at).not.toBeNull();
    const audit = writeAuditMock.mock.calls[0][0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(audit.before).toEqual({ external_ref: "lark:tenant-1:ou_old" });
    expect(audit.after.replaced_previous_link).toBe(true);
  });

  it("fails closed: if the audit row cannot be written the link is rolled back and the old link restored", async () => {
    linkIdentity(db, ids.manager, "ou_old");
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    writeAuditMock.mockRejectedValueOnce(new Error("audit down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await link({ rawCode: code, externalUserId: "ou_new" });

    expect(out.status).toBe("error");
    const active = db.rows("external_identities").filter((r) => r.revoked_at == null);
    expect(active.map((r) => r.external_user_id)).toEqual(["ou_old"]);
  });

  it("never throws: a database failure becomes a typed error outcome", async () => {
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    db.failNext({ table: "identity_link_codes", op: "select", error: { message: "db down" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(link({ rawCode: code })).resolves.toMatchObject({ status: "error" });
  });
});

describe("lookupIdentity / listIdentities", () => {
  it("resolves only ACTIVE links in the connector's workspace", async () => {
    linkIdentity(db, ids.manager, "ou_alice");
    expect(await lookupIdentity(connector, "tenant-1", "ou_alice")).toEqual({
      profileId: ids.manager,
      role: "manager",
      label: "Max Manager",
    });
    expect(await lookupIdentity(connector, "tenant-2", "ou_alice")).toBeNull(); // wrong tenant
    expect(await lookupIdentity(connector, "tenant-1", "ou_nobody")).toBeNull();
    db.rows("external_identities")[0].revoked_at = "2026-10-10T00:00:00.000Z";
    expect(await lookupIdentity(connector, "tenant-1", "ou_alice")).toBeNull();
  });

  it("members see their own links, admins see the workspace's — masked, workspace-scoped", async () => {
    linkIdentity(db, ids.manager, "ou_1234567890abcdef");
    linkIdentity(db, ids.manager2, "ou_zzzzzzzzzzzzzzzz");
    db.seed("external_identities", [
      {
        id: "foreign",
        workspace_id: OTHER_WS,
        connector_id: "other",
        provider: "lark",
        external_tenant: "t",
        external_user_id: "ou_foreign_user_id",
        profile_id: "p-foreign",
        linked_at: "2026-10-03T00:00:00.000Z",
        revoked_at: null,
      },
    ]);

    const mine = await listIdentities({ workspaceId: WS, profileId: ids.manager });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ profile_id: ids.manager, profile_label: "Max Manager", external_user_hint: "ou_123…cdef" });
    expect(JSON.stringify(mine)).not.toContain("ou_1234567890abcdef");

    const all = await listIdentities({ workspaceId: WS });
    expect(all.map((r) => r.profile_id).sort()).toEqual([ids.manager, ids.manager2].sort());
    expect(JSON.stringify(all)).not.toContain("foreign");
  });
});

describe("tenant pin — the first successful link pins the connector to its Lark tenant", () => {
  const MESSAGE = "This Lark workspace is not the one connected to NoPM";
  const pinned = () => db.rows("integration_connectors")[0].tenant_key;
  const mintFor = (profileId: string) => mintLinkCode({ workspaceId: WS, profileId, connectorId: CONNECTOR_ID });

  it("pins the event's tenant atomically on the first link and records it in that link's audit row", async () => {
    expect(pinned()).toBeNull();
    const { code } = await mintFor(ids.manager);

    expect((await link({ rawCode: code, externalTenant: "tenant-A" })).status).toBe("linked");

    expect(pinned()).toBe("tenant-A");
    expect(writeAuditMock).toHaveBeenCalledTimes(1); // the pin is part of the link mutation, not a second one
    expect((writeAuditMock.mock.calls[0][0] as Record<string, any>).after.tenant_pinned).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it("refuses a link code consumed from any OTHER tenant: forbidden, code not burned, nothing linked or audited", async () => {
    const first = await mintFor(ids.manager);
    await link({ rawCode: first.code, externalTenant: "tenant-A" });
    writeAuditMock.mockClear();
    const second = await mintFor(ids.manager2);

    // fresh connector row (as every request loads it): rejected up front
    const fresh = { ...connector, tenant_key: "tenant-A" };
    const early = await consumeLinkCode({ connector: fresh, rawCode: second.code, externalTenant: "tenant-B", externalUserId: "ou_mia" });
    expect(early).toEqual({ status: "forbidden", message: MESSAGE });

    // stale row (loaded before the pin landed): the atomic pin still refuses
    const stale = await consumeLinkCode({ connector, rawCode: second.code, externalTenant: "tenant-B", externalUserId: "ou_mia" });
    expect(stale).toEqual({ status: "forbidden", message: MESSAGE });

    expect(pinned()).toBe("tenant-A");
    expect(db.rows("external_identities").map((r) => r.profile_id)).toEqual([ids.manager]);
    expect(db.rows("identity_link_codes").find((c) => c.profile_id === ids.manager2)!.used_at).toBeNull();
    expect(writeAuditMock).not.toHaveBeenCalled();

    // the same code still works from the right tenant
    const ok = await consumeLinkCode({ connector: fresh, rawCode: second.code, externalTenant: "tenant-A", externalUserId: "ou_mia" });
    expect(ok.status).toBe("linked");
  });

  it("later links from the pinned tenant do not re-pin (and say so in the audit row)", async () => {
    await link({ rawCode: (await mintFor(ids.manager)).code, externalTenant: "tenant-A" });
    writeAuditMock.mockClear();
    const out = await link({ rawCode: (await mintFor(ids.manager2)).code, externalTenant: "tenant-A", externalUserId: "ou_mia" });
    expect(out.status).toBe("linked");
    expect(pinned()).toBe("tenant-A");
    expect((writeAuditMock.mock.calls[0][0] as Record<string, any>).after.tenant_pinned).toBe(false); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it("of two tenants racing to link first, exactly one wins the pin", async () => {
    const a = await mintFor(ids.manager);
    const b = await mintFor(ids.manager2);

    const [ra, rb] = await Promise.all([
      link({ rawCode: a.code, externalTenant: "tenant-A", externalUserId: "ou_a" }),
      link({ rawCode: b.code, externalTenant: "tenant-B", externalUserId: "ou_b" }),
    ]);

    expect([ra.status, rb.status].sort()).toEqual(["forbidden", "linked"]);
    expect(["tenant-A", "tenant-B"]).toContain(pinned());
    const linkedTenants = db.rows("external_identities").map((r) => r.external_tenant);
    expect(linkedTenants).toEqual([pinned()]);
  });

  it("re-confirming an existing link pins nothing", async () => {
    linkIdentity(db, ids.manager, "ou_alice", "tenant-A");
    const { code } = await mintFor(ids.manager);
    const out = await link({ rawCode: code, externalTenant: "tenant-A" });
    expect(out).toMatchObject({ status: "linked", alreadyLinked: true });
    expect(pinned()).toBeNull();
  });

  it("releases the pin it just took when the link is rolled back (audit failure), and leaves an existing pin alone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { code } = await mintFor(ids.manager);
    writeAuditMock.mockRejectedValueOnce(new Error("audit down"));

    expect((await link({ rawCode: code, externalTenant: "tenant-A" })).status).toBe("error");
    expect(pinned()).toBeNull();
    expect(db.rows("external_identities").filter((r) => r.revoked_at == null)).toHaveLength(0);

    // a pin that was already there is not ours to release
    db.rows("integration_connectors")[0].tenant_key = "tenant-A";
    writeAuditMock.mockRejectedValueOnce(new Error("audit down"));
    const again = await mintFor(ids.manager);
    await consumeLinkCode({
      connector: { ...connector, tenant_key: "tenant-A" },
      rawCode: again.code,
      externalTenant: "tenant-A",
      externalUserId: "ou_alice",
    });
    expect(pinned()).toBe("tenant-A");
  });

  it("after an admin clears the pin, a different tenant can become the new pin", async () => {
    await link({ rawCode: (await mintFor(ids.manager)).code, externalTenant: "tenant-A" });
    db.rows("integration_connectors")[0].tenant_key = null; // what PATCH clear_tenant_pin does
    const out = await link({ rawCode: (await mintFor(ids.manager2)).code, externalTenant: "tenant-B", externalUserId: "ou_mia" });
    expect(out.status).toBe("linked");
    expect(pinned()).toBe("tenant-B");
  });

  it("a conflict (account already linked to someone else) does not pin either", async () => {
    linkIdentity(db, ids.manager2, "ou_alice", "tenant-A");
    const { code } = await mintFor(ids.manager);
    expect((await link({ rawCode: code, externalTenant: "tenant-A" })).status).toBe("conflict");
    expect(pinned()).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
const { writeAuditMock } = vi.hoisted(() => ({
  writeAuditMock: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/audit/write", () => ({ writeAudit: writeAuditMock }));

import {
  ALREADY_LINKED_MESSAGE,
  LINK_ATTEMPTS_PER_CONNECTOR,
  LINK_ATTEMPTS_PER_SENDER,
  LINK_ATTEMPT_WINDOW_SECONDS,
  LINK_CODE_TTL_MS,
  consumeLinkCode,
  externalActorRef,
  generateLinkCode,
  hashLinkCode,
  listIdentities,
  lookupIdentity,
  maskExternalId,
  maskedExternalRef,
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

/**
 * A link of this profile that lands AFTER the refusal check but before the write (two codes
 * racing): the only way an existing link can still be replaced.
 */
function oldLinkAppearsWhenCodeIsSpent(profileId: string, openId: string) {
  const realFrom = db.from.bind(db);
  db.from = (table: string) => {
    const q = realFrom(table);
    if (table === "identity_link_codes") {
      const update = q.update.bind(q);
      q.update = (patch) => {
        linkIdentity(db, profileId, openId);
        return update(patch);
      };
    }
    return q;
  };
}

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
    // the reference stored on audit rows is the MASKED one (the audit stream is member-readable)
    expect(externalActorRef("lark", "t1", "ou_x")).toBe("lark:t1…:ou…");
    expect(externalActorRef("lark", "tenant-abcdef123456", "ou_0123456789abcdef")).toBe("lark:tenant…3456:ou_012…cdef");
    expect(externalActorRef("lark", "tenant-abcdef123456", "ou_0123456789abcdef")).toBe(
      maskedExternalRef("lark", "tenant-abcdef123456", "ou_0123456789abcdef"),
    );
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
      externalActorRef: "lark:te…:ou…",
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

  it("re-confirming an existing link is a pure no-op: no audit row, no state change, and the code is NOT burned", async () => {
    linkIdentity(db, ids.manager, "ou_alice");
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    const before = JSON.stringify(db.tables);

    expect(await link({ rawCode: code })).toEqual({ status: "linked", profileLabel: "Max Manager", alreadyLinked: true });

    expect(db.rows("external_identities")).toHaveLength(1);
    expect(writeAuditMock).not.toHaveBeenCalled();
    expect(db.rows("identity_link_codes")[0].used_at).toBeNull(); // not consumed
    expect(JSON.stringify(db.tables)).toBe(before); // nothing at all changed

    // the still-live code is NOT a way to move the link to a second platform account
    const next = await link({ rawCode: code, externalUserId: "ou_alice_phone" });
    expect(next.status).toBe("conflict");
    expect(db.rows("identity_link_codes")[0].used_at).not.toBeNull();
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({ action: "integration.identity.link.blocked" });
    expect(db.rows("external_identities").filter((r) => r.revoked_at == null).map((r) => r.external_user_id)).toEqual(["ou_alice"]);
  });

  it("never moves an existing link: a user already linked to another account is refused, the code is spent, and the refusal is audited", async () => {
    linkIdentity(db, ids.manager, "ou_old_open_id_value");
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    const identitiesBefore = JSON.stringify(db.rows("external_identities"));

    const out = await link({ rawCode: code, externalTenant: "tenant-abcdef123456", externalUserId: "ou_new_open_id_value", externalEventId: "evt-leak" });

    expect(out).toEqual({ status: "conflict", message: ALREADY_LINKED_MESSAGE });
    expect(ALREADY_LINKED_MESSAGE).toBe(
      "This NoPM account is already linked to another Lark account. Unlink it in NoPM (Integrations) first, then send a new code.",
    );
    expect(JSON.stringify(db.rows("external_identities"))).toBe(identitiesBefore); // the owner's link is untouched
    expect(db.rows("identity_link_codes")[0].used_at).not.toBeNull(); // a leaked code is dead after one try
    expect(db.rows("notifications")).toHaveLength(0);
    expect(db.rows("integration_connectors")[0].tenant_key ?? null).toBeNull(); // and nothing was pinned

    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const audit = writeAuditMock.mock.calls[0][0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(audit).toMatchObject({
      workspaceId: WS,
      action: "integration.identity.link.blocked",
      targetType: "external_identity",
      after: { profile_id: ids.manager, reason: "profile_already_linked", connector_id: CONNECTOR_ID },
    });
    expect(audit.actor).toMatchObject({ id: ids.manager, channel: "lark", viaConnectorId: CONNECTOR_ID, externalEventId: "evt-leak" });
    // masked like every audit row the members can read
    const text = JSON.stringify({ before: audit.before, after: audit.after });
    expect(text).not.toContain("ou_old_open_id_value");
    expect(text).not.toContain("ou_new_open_id_value");
    expect(text).not.toContain("tenant-abcdef123456");
    expect(audit.after.external_ref).toBe(maskedExternalRef("lark", "tenant-abcdef123456", "ou_new_open_id_value"));
  });

  it("a refused link is still answered if its audit row cannot be written (a refusal changes nothing)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    linkIdentity(db, ids.manager, "ou_old");
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    writeAuditMock.mockRejectedValueOnce(new Error("audit down"));
    expect((await link({ rawCode: code, externalUserId: "ou_new" })).status).toBe("conflict");
    expect(db.rows("external_identities").filter((r) => r.revoked_at == null).map((r) => r.external_user_id)).toEqual(["ou_old"]);
  });

  it("after the owner unlinks in NoPM, a fresh code links the new account normally", async () => {
    const old = linkIdentity(db, ids.manager, "ou_old");
    const first = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    expect((await link({ rawCode: first.code, externalUserId: "ou_new" })).status).toBe("conflict");

    old.revoked_at = "2026-10-16T09:00:00.000Z";
    db.rows("external_identities")[0].revoked_at = "2026-10-16T09:00:00.000Z"; // unlinked under Integrations
    const second = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    expect((await link({ rawCode: second.code, externalUserId: "ou_new" })).status).toBe("linked");
    expect(db.rows("external_identities").filter((r) => r.revoked_at == null).map((r) => r.external_user_id)).toEqual(["ou_new"]);
  });

  it("the throttle still counts a refused attempt", async () => {
    linkIdentity(db, ids.manager, "ou_old");
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    const calls: string[] = [];
    const rpc = db.rpc.bind(db);
    db.rpc = async (...args: unknown[]) => {
      calls.push(String((args[1] as { p_key?: string } | undefined)?.p_key));
      return rpc();
    };
    await link({ rawCode: code, externalUserId: "ou_new" });
    expect(calls.some((k) => k.startsWith("lark-link:"))).toBe(true);
  });

  it("if two codes race and an old link appears after the check, the old link is still replaced (and announced)", async () => {
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    oldLinkAppearsWhenCodeIsSpent(ids.manager, "ou_old");
    expect((await link({ rawCode: code, externalUserId: "ou_new" })).status).toBe("linked");

    const active = db.rows("external_identities").filter((r) => r.revoked_at == null);
    expect(active).toHaveLength(1);
    expect(active[0].external_user_id).toBe("ou_new");
    expect(db.rows("external_identities").find((r) => r.external_user_id === "ou_old")?.revoked_at).not.toBeNull();
    const audit = writeAuditMock.mock.calls[0][0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    // masked: the audit stream is member-readable (the full reference is the actor's external_actor_ref)
    expect(audit.before).toEqual({ external_ref: "lark:te…:ou…" });
    expect(audit.after.replaced_previous_link).toBe(true);
  });

  it("fails closed: if the audit row cannot be written the link is rolled back and the old link restored", async () => {
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    oldLinkAppearsWhenCodeIsSpent(ids.manager, "ou_old");
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

describe("consumeLinkCode — guessing a code is throttled", () => {
  type Call = { key: string; max: number; window: number };
  function watchRate(decide: (call: Call) => { allowed: boolean; retry?: number } | "error" = () => ({ allowed: true })) {
    const calls: Call[] = [];
    (db as unknown as { rpc: unknown }).rpc = async (_fn: string, args: Record<string, unknown>) => {
      const call = { key: String(args.p_key), max: Number(args.p_max), window: Number(args.p_window_seconds) };
      calls.push(call);
      const verdict = decide(call);
      if (verdict === "error") return { data: null, error: { message: "rpc down" } };
      return { data: { allowed: verdict.allowed, remaining: 0, retry_after_seconds: verdict.retry ?? 0 }, error: null };
    };
    return calls;
  }

  it("charges one attempt to the sender and one to the connector, in a 10 minute window, with no platform id in the key", async () => {
    const calls = watchRate();
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    await link({ rawCode: code, externalUserId: "ou_alice_secret_id" });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ max: LINK_ATTEMPTS_PER_SENDER, window: LINK_ATTEMPT_WINDOW_SECONDS });
    expect(calls[1]).toEqual({ key: `lark-link-conn:${CONNECTOR_ID}`, max: LINK_ATTEMPTS_PER_CONNECTOR, window: LINK_ATTEMPT_WINDOW_SECONDS });
    expect(calls[0].key).toMatch(new RegExp(`^lark-link:${CONNECTOR_ID}:[0-9a-f]{32}$`));
    expect(JSON.stringify(calls)).not.toContain("ou_alice_secret_id");
    expect(JSON.stringify(calls)).not.toContain("tenant-1");
  });

  it("refuses with 'rate_limited' once the sender is over, and does not even look the code up or burn it", async () => {
    watchRate((c) => (c.key.startsWith("lark-link:") ? { allowed: false, retry: 413 } : { allowed: true }));
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    db.log.length = 0;

    expect(await link({ rawCode: code })).toEqual({ status: "rate_limited", retryAfterSeconds: 413 });

    expect(db.log.filter((l) => l.table === "identity_link_codes")).toHaveLength(0);
    expect(db.rows("identity_link_codes")[0].used_at).toBeNull();
    expect(db.rows("external_identities")).toHaveLength(0);
  });

  it("also refuses when the CONNECTOR as a whole is over (many senders guessing)", async () => {
    watchRate((c) => (c.key.startsWith("lark-link-conn:") ? { allowed: false, retry: 77 } : { allowed: true }));
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    expect(await link({ rawCode: code })).toEqual({ status: "rate_limited", retryAfterSeconds: 77 });
  });

  it("a malformed code costs nothing (no database work, no budget)", async () => {
    const calls = watchRate();
    expect(await link({ rawCode: "not a code" })).toEqual({ status: "invalid_code" });
    expect(calls).toHaveLength(0);
  });

  it("fails CLOSED when the counter is unavailable: the limiter is the only throttle on a 40-bit code (F5)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    watchRate(() => "error");
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    db.log.length = 0;

    expect(await link({ rawCode: code })).toMatchObject({ status: "rate_limited" });

    // the code was not even looked up, let alone burned, so the person can retry when the counter is back
    expect(db.log.filter((l) => l.table === "identity_link_codes")).toHaveLength(0);
    expect(db.rows("identity_link_codes")[0].used_at).toBeNull();
    expect(db.rows("external_identities")).toHaveLength(0);
    watchRate();
    expect((await link({ rawCode: code })).status).toBe("linked");
  });

  it("different senders have different budgets", async () => {
    const calls = watchRate();
    await link({ rawCode: "NPL-AAAA-BBBB", externalUserId: "ou_one" });
    await link({ rawCode: "NPL-AAAA-BBBB", externalUserId: "ou_two" });
    expect(new Set(calls.filter((c) => c.key.startsWith("lark-link:")).map((c) => c.key)).size).toBe(2);
  });
});

describe("consumeLinkCode — only an approver's link may pin the tenant", () => {
  const pinned = () => db.rows("integration_connectors")[0].tenant_key;

  it("a viewer's first link still links, but does not pin the connector to their tenant", async () => {
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.viewer, connectorId: CONNECTOR_ID });
    expect((await link({ rawCode: code, externalTenant: "tenant-foreign", externalUserId: "ou_viewer" })).status).toBe("linked");
    expect(pinned()).toBeNull();
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({ after: { tenant_pinned: false } });
  });

  it("a member's first link does not pin either", async () => {
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.member, connectorId: CONNECTOR_ID });
    await link({ rawCode: code, externalTenant: "tenant-foreign", externalUserId: "ou_member" });
    expect(pinned()).toBeNull();
  });

  it("the real tenant's manager can then still pin it (the foreign viewer did not lock them out)", async () => {
    const viewer = await mintLinkCode({ workspaceId: WS, profileId: ids.viewer, connectorId: CONNECTOR_ID });
    await link({ rawCode: viewer.code, externalTenant: "tenant-foreign", externalUserId: "ou_viewer" });

    const manager = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    expect((await link({ rawCode: manager.code, externalTenant: "tenant-real", externalUserId: "ou_max" })).status).toBe("linked");
    expect(pinned()).toBe("tenant-real");
  });

  it.each([
    ["an admin", ids.admin],
    ["a manager", ids.manager],
  ])("%s's first link pins the connector", async (_label, profileId) => {
    const { code } = await mintLinkCode({ workspaceId: WS, profileId, connectorId: CONNECTOR_ID });
    await link({ rawCode: code, externalTenant: "tenant-real", externalUserId: "ou_boss" });
    expect(pinned()).toBe("tenant-real");
    expect(writeAuditMock.mock.calls[0][0]).toMatchObject({ after: { tenant_pinned: true } });
  });

  it("once pinned, a viewer from another tenant is refused (and the code stays usable)", async () => {
    db.rows("integration_connectors")[0].tenant_key = "tenant-real";
    connector = { ...connector, tenant_key: "tenant-real" };
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.viewer, connectorId: CONNECTOR_ID });
    const out = await link({ rawCode: code, externalTenant: "tenant-foreign", externalUserId: "ou_viewer" });
    expect(out.status).toBe("forbidden");
    expect(db.rows("identity_link_codes")[0].used_at).toBeNull();
    expect(db.rows("external_identities")).toHaveLength(0);
  });

  it("once pinned, a viewer from the pinned tenant links normally", async () => {
    db.rows("integration_connectors")[0].tenant_key = "tenant-real";
    connector = { ...connector, tenant_key: "tenant-real" };
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.viewer, connectorId: CONNECTOR_ID });
    expect((await link({ rawCode: code, externalTenant: "tenant-real", externalUserId: "ou_viewer" })).status).toBe("linked");
  });
});

describe("consumeLinkCode — a replaced link is announced", () => {
  const notices = () => db.rows("notifications") as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any

  it("reports the displaced account to the adapter and tells the profile in NoPM", async () => {
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    oldLinkAppearsWhenCodeIsSpent(ids.manager, "ou_old");

    const out = await link({ rawCode: code, externalUserId: "ou_new" });

    expect(out).toMatchObject({
      status: "linked",
      alreadyLinked: false,
      displaced: [{ externalTenant: "tenant-1", externalUserId: "ou_old" }],
    });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({
      workspace_id: WS,
      recipient_id: ids.manager,
      type: "integration.link_replaced",
    });
    expect(String(notices()[0].body)).toMatch(/not you/i);
    expect(JSON.stringify(notices())).not.toContain("ou_old");
    expect(JSON.stringify(notices())).not.toContain("ou_new");
  });

  it("says nothing about a first link", async () => {
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    const out = await link({ rawCode: code });
    expect(out.status).toBe("linked");
    expect((out as { displaced?: unknown }).displaced).toBeUndefined();
    expect(notices()).toHaveLength(0);
  });

  it("a failed notification never undoes the link", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    oldLinkAppearsWhenCodeIsSpent(ids.manager, "ou_old");
    db.failNext({ table: "notifications", op: "insert", error: { message: "notifications down" } });

    const out = await link({ rawCode: code, externalUserId: "ou_new" });

    expect(out.status).toBe("linked");
    expect(db.rows("external_identities").filter((r) => r.revoked_at == null).map((r) => r.external_user_id)).toEqual(["ou_new"]);
  });

  it("a rolled-back link (audit down) announces nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    oldLinkAppearsWhenCodeIsSpent(ids.manager, "ou_old");
    writeAuditMock.mockRejectedValueOnce(new Error("audit down"));
    expect((await link({ rawCode: code, externalUserId: "ou_new" })).status).toBe("error");
    expect(notices()).toHaveLength(0);
  });
});

describe("consumeLinkCode — the audit row masks platform ids but the actor keeps the full reference", () => {
  it("masks tenant and open id in before/after AND in the external_actor_ref the actor carries into audit_log", async () => {
    const { code } = await mintLinkCode({ workspaceId: WS, profileId: ids.manager, connectorId: CONNECTOR_ID });
    oldLinkAppearsWhenCodeIsSpent(ids.manager, "ou_old_open_id_value");
    await link({ rawCode: code, externalTenant: "tenant-abcdef123456", externalUserId: "ou_new_open_id_value" });

    const audit = writeAuditMock.mock.calls[0][0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const text = JSON.stringify({ before: audit.before, after: audit.after });
    expect(text).not.toContain("ou_new_open_id_value");
    expect(text).not.toContain("ou_old_open_id_value");
    expect(text).not.toContain("tenant-abcdef123456");
    expect(audit.after.external_ref).toBe(maskedExternalRef("lark", "tenant-abcdef123456", "ou_new_open_id_value"));
    // audit_log.external_actor_ref is readable by every member too: nothing raw is stored in it
    expect(audit.actor.externalActorRef).toBe(maskedExternalRef("lark", "tenant-abcdef123456", "ou_new_open_id_value"));
    expect(JSON.stringify(audit.actor)).not.toContain("ou_new_open_id_value");
    expect(JSON.stringify(audit.actor)).not.toContain("tenant-abcdef123456");
  });
});

describe("maskedExternalRef", () => {
  it("masks both parts and keeps the provider", () => {
    expect(maskedExternalRef("lark", "tenant-abcdef123456", "ou_0123456789abcdef")).toBe("lark:tenant…3456:ou_012…cdef");
    expect(maskedExternalRef("lark", "t1", "ou_1")).toBe("lark:t1…:ou…");
  });
});

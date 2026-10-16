import { createHash, randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import type { Actor } from "@/lib/auth/guard";
import { sanitizeError } from "@/lib/integrations/secrets";
import { TENANT_MISMATCH_MESSAGE, tenantMismatch } from "@/lib/integrations/store";
import type { ConnectorRow } from "@/lib/integrations/types";

/**
 * External identity linking (D7): a platform user is bound to a NoPM profile
 * ONLY by consuming a one-time code that a signed-in NoPM user minted and then
 * DM'd to the bot. The bot event carries the platform-verified user id and
 * tenant, so the code proves "this platform account is controlled by the person
 * who holds this NoPM session". Never by email match.
 *
 * Codes are `NPL-XXXX-XXXX` (8 symbols from a 32-char alphabet without the
 * look-alikes I/O/0/1 = 40 bits), valid 10 minutes, single use, stored as a
 * SHA-256 hash. One live code per profile+connector (minting replaces the
 * previous one). One ACTIVE link per profile per connector, and one profile
 * per platform account.
 */

export const LINK_CODE_TTL_MS = 10 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 symbols: 256 % 32 === 0 => unbiased
const CODE_PATTERN = /^NPL-?([A-Z2-9]{4})-?([A-Z2-9]{4})$/;

export function generateLinkCode(): string {
  const bytes = randomBytes(8);
  let chars = "";
  for (const b of bytes) chars += CODE_ALPHABET[b & 31];
  return `NPL-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** Canonicalise what a user typed (any case, with/without dashes/spaces). Null when malformed. */
export function normalizeLinkCode(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const m = CODE_PATTERN.exec(input.replace(/\s+/g, "").toUpperCase());
  return m ? `NPL-${m[1]}-${m[2]}` : null;
}

export function hashLinkCode(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
}

/** Mask a platform id for display: enough to recognise, not enough to reuse. */
export function maskExternalId(id: string): string {
  return id.length <= 10 ? `${id.slice(0, 2)}…` : `${id.slice(0, 6)}…${id.slice(-4)}`;
}

/** `lark:<tenant>:<user>` — the external actor reference written to audit rows. */
export function externalActorRef(provider: string, tenant: string, userId: string): string {
  return `${provider}:${tenant}:${userId}`;
}

// ── mint ───────────────────────────────────────────────────────────────────

export async function mintLinkCode(input: {
  workspaceId: string;
  profileId: string;
  connectorId: string;
}): Promise<{ code: string; expiresAt: string }> {
  const db = createAdminClient();

  // One live code per profile+connector: drop any unused earlier code.
  const { error: clearError } = await db
    .from("identity_link_codes")
    .delete()
    .eq("workspace_id", input.workspaceId)
    .eq("connector_id", input.connectorId)
    .eq("profile_id", input.profileId)
    .is("used_at", null);
  if (clearError) throw clearError;

  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS).toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateLinkCode();
    const { error } = await db.from("identity_link_codes").insert({
      workspace_id: input.workspaceId,
      connector_id: input.connectorId,
      profile_id: input.profileId,
      code_hash: hashLinkCode(code),
      expires_at: expiresAt,
    });
    if (!error) return { code, expiresAt };
    if (error.code !== "23505") throw error; // anything but a hash collision is real
  }
  throw new Error("Could not generate a unique link code");
}

// ── consume (from the bot DM) ──────────────────────────────────────────────

export type LinkOutcome =
  | { status: "linked"; profileLabel: string; alreadyLinked: boolean }
  | { status: "invalid_code" }
  | { status: "expired" }
  | { status: "already_used" }
  | { status: "conflict"; message: string }
  | { status: "paused" }
  | { status: "forbidden"; message: string }
  | { status: "error"; message: string };

export type ConsumeLinkInput = {
  connector: ConnectorRow;
  rawCode: string;
  externalTenant: string;
  externalUserId: string;
  externalUnionId?: string | null;
  displayName?: string | null;
  externalEventId?: string | null;
};

type CodeRow = {
  id: string;
  profile_id: string;
  used_at: string | null;
  expires_at: string;
};

/**
 * Consume a link code sent from a verified bot DM and create the identity
 * link. Never throws — every failure is a typed outcome the adapter turns into
 * a bot reply. The link itself is audited (`integration.identity.link`) with
 * the CODE OWNER as actor and `channel='lark'`; if that audit write fails the
 * link is rolled back (fail-closed), so there is never an unaudited link.
 *
 * Tenant pin: the FIRST successful link pins the connector to the event's
 * tenant (atomically — of two tenants racing to link first, exactly one wins);
 * from then on a code consumed from any other tenant is refused with
 * `forbidden` and left unburned. The pin is part of the link mutation and is
 * recorded in its audit row (`after.tenant_pinned`); if the link is rolled
 * back the pin is released with it.
 */
export async function consumeLinkCode(input: ConsumeLinkInput): Promise<LinkOutcome> {
  const { connector } = input;
  if (connector.status !== "active") return { status: "paused" };
  const code = normalizeLinkCode(input.rawCode);
  if (!code) return { status: "invalid_code" };
  const externalTenant = input.externalTenant.trim();
  const externalUserId = input.externalUserId.trim();
  if (!externalTenant || !externalUserId) return { status: "error", message: "Missing platform identity" };
  if (tenantMismatch(connector, externalTenant)) return { status: "forbidden", message: TENANT_MISMATCH_MESSAGE };

  let pinnedHere = false;
  let completed = false;
  try {
    const db = createAdminClient();
    const codeHash = hashLinkCode(code);

    const { data: found, error: findError } = await db
      .from("identity_link_codes")
      .select("id, profile_id, used_at, expires_at")
      .eq("code_hash", codeHash)
      .eq("workspace_id", connector.workspace_id)
      .eq("connector_id", connector.id)
      .maybeSingle();
    if (findError) throw findError;
    const row = found as CodeRow | null;
    if (!row) return { status: "invalid_code" };
    if (row.used_at) return { status: "already_used" };
    if (new Date(row.expires_at).getTime() <= Date.now()) return { status: "expired" };

    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("id, role, display_name, email")
      .eq("id", row.profile_id)
      .eq("workspace_id", connector.workspace_id)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile) return { status: "invalid_code" };
    const label: string = profile.display_name || profile.email || profile.id;

    // Conflict checks BEFORE the code is burned, so a refused link leaves the
    // code usable for a corrected attempt.
    const { data: sameAccount, error: sameError } = await db
      .from("external_identities")
      .select("id, profile_id")
      .eq("workspace_id", connector.workspace_id)
      .eq("connector_id", connector.id)
      .eq("external_tenant", externalTenant)
      .eq("external_user_id", externalUserId)
      .is("revoked_at", null)
      .maybeSingle();
    if (sameError) throw sameError;
    if (sameAccount && sameAccount.profile_id !== profile.id) {
      return {
        status: "conflict",
        message: "This account is already linked to another NoPM user. Ask them (or an admin) to unlink it first.",
      };
    }

    // Re-confirming a link that already exists is a pure no-op: nothing is
    // linked, pinned or audited, and the code is NOT burned (burning it would be
    // a state change with no audit row). The person is simply told it is linked.
    if (sameAccount) return { status: "linked", profileLabel: label, alreadyLinked: true };

    // Pin the tenant on the first NEW link (before the code is burned, so a
    // refused tenant leaves the code usable).
    const pin = await pinTenant(connector, externalTenant);
    if (pin === "mismatch") return { status: "forbidden", message: TENANT_MISMATCH_MESSAGE };
    pinnedHere = pin === "pinned";

    const nowIso = new Date().toISOString();
    const { data: consumed, error: consumeError } = await db
      .from("identity_link_codes")
      .update({ used_at: nowIso })
      .eq("id", row.id)
      .eq("workspace_id", connector.workspace_id)
      .is("used_at", null)
      .gt("expires_at", nowIso)
      .select("id");
    if (consumeError) throw consumeError;
    if (!consumed || consumed.length === 0) return { status: "already_used" };

    // One active link per profile per connector: a fresh link replaces any
    // earlier one (e.g. the person moved to a different platform account).
    const { data: replaced, error: replaceError } = await db
      .from("external_identities")
      .update({ revoked_at: nowIso })
      .eq("workspace_id", connector.workspace_id)
      .eq("connector_id", connector.id)
      .eq("profile_id", profile.id)
      .is("revoked_at", null)
      .select("id, external_tenant, external_user_id");
    if (replaceError) throw replaceError;
    const replacedRows = (replaced ?? []) as { id: string; external_tenant: string; external_user_id: string }[];

    const { data: inserted, error: insertError } = await db
      .from("external_identities")
      .insert({
        workspace_id: connector.workspace_id,
        connector_id: connector.id,
        provider: connector.kind,
        external_tenant: externalTenant,
        external_user_id: externalUserId,
        external_union_id: input.externalUnionId ?? null,
        display_name: input.displayName ?? null,
        profile_id: profile.id,
      })
      .select("id")
      .single();
    if (insertError || !inserted) {
      await restoreReplaced(replacedRows.map((r) => r.id), connector.workspace_id);
      if (insertError?.code === "23505") {
        return { status: "conflict", message: "This account is already linked. Unlink it first, then try again." };
      }
      throw insertError ?? new Error("Identity insert returned no row");
    }

    const actor: Actor = {
      type: "user",
      id: profile.id,
      principalId: profile.id,
      label,
      workspaceId: connector.workspace_id,
      role: profile.role,
      channel: "lark",
      viaConnectorId: connector.id,
      externalEventId: input.externalEventId ?? undefined,
      externalActorRef: externalActorRef(connector.kind, externalTenant, externalUserId),
    };
    try {
      await writeAudit({
        workspaceId: connector.workspace_id,
        actor,
        action: "integration.identity.link",
        targetType: "external_identity",
        targetId: inserted.id,
        before: replacedRows.length
          ? { external_ref: externalActorRef(connector.kind, replacedRows[0].external_tenant, replacedRows[0].external_user_id) }
          : null,
        after: {
          connector_id: connector.id,
          provider: connector.kind,
          profile_id: profile.id,
          external_ref: externalActorRef(connector.kind, externalTenant, externalUserId),
          replaced_previous_link: replacedRows.length > 0,
          tenant_pinned: pinnedHere,
        },
      });
    } catch (auditError) {
      // Fail-closed: undo the link rather than leave an unaudited one.
      await db.from("external_identities").update({ revoked_at: nowIso }).eq("id", inserted.id).eq("workspace_id", connector.workspace_id);
      await restoreReplaced(replacedRows.map((r) => r.id), connector.workspace_id);
      throw auditError;
    }

    completed = true;
    return { status: "linked", profileLabel: label, alreadyLinked: false };
  } catch (err) {
    console.error("[integrations] link code consume failed:", sanitizeError(err));
    return { status: "error", message: "Could not link your account right now. Please try again." };
  } finally {
    // Any exit that did not complete the link releases a pin taken for it.
    if (pinnedHere && !completed) await releasePin(connector, externalTenant).catch(() => {});
  }
}

/**
 * Atomically pin the connector to `tenant` if (and only if) it is not pinned
 * yet: a conditional UPDATE on `tenant_key is null`. "mismatch" = pinned to a
 * different tenant (including losing a race to one).
 */
async function pinTenant(
  connector: Pick<ConnectorRow, "id" | "workspace_id" | "tenant_key">,
  tenant: string,
): Promise<"pinned" | "already" | "mismatch"> {
  if (connector.tenant_key) return connector.tenant_key === tenant ? "already" : "mismatch";
  const db = createAdminClient();
  const { data, error } = await db
    .from("integration_connectors")
    .update({ tenant_key: tenant })
    .eq("id", connector.id)
    .eq("workspace_id", connector.workspace_id)
    .is("tenant_key", null)
    .select("id");
  if (error) throw error;
  if (data && data.length > 0) return "pinned";

  const { data: current, error: readError } = await db
    .from("integration_connectors")
    .select("tenant_key")
    .eq("id", connector.id)
    .eq("workspace_id", connector.workspace_id)
    .maybeSingle();
  if (readError) throw readError;
  return current?.tenant_key === tenant ? "already" : "mismatch";
}

async function releasePin(connector: Pick<ConnectorRow, "id" | "workspace_id">, tenant: string): Promise<void> {
  const db = createAdminClient();
  await db
    .from("integration_connectors")
    .update({ tenant_key: null })
    .eq("id", connector.id)
    .eq("workspace_id", connector.workspace_id)
    .eq("tenant_key", tenant);
}

async function restoreReplaced(ids: string[], workspaceId: string): Promise<void> {
  if (ids.length === 0) return;
  const db = createAdminClient();
  await db.from("external_identities").update({ revoked_at: null }).in("id", ids).eq("workspace_id", workspaceId);
}

// ── lookup / list / unlink ─────────────────────────────────────────────────

export type LinkedProfile = { profileId: string; role: string; label: string };

/** Resolve a verified platform user to the linked NoPM profile (active link only). */
export async function lookupIdentity(
  connector: Pick<ConnectorRow, "id" | "workspace_id">,
  externalTenant: string,
  externalUserId: string,
): Promise<LinkedProfile | null> {
  const db = createAdminClient();
  const { data: identity, error } = await db
    .from("external_identities")
    .select("profile_id")
    .eq("workspace_id", connector.workspace_id)
    .eq("connector_id", connector.id)
    .eq("external_tenant", externalTenant)
    .eq("external_user_id", externalUserId)
    .is("revoked_at", null)
    .maybeSingle();
  if (error || !identity) return null;
  const { data: profile } = await db
    .from("profiles")
    .select("id, role, display_name, email")
    .eq("id", identity.profile_id)
    .eq("workspace_id", connector.workspace_id)
    .maybeSingle();
  if (!profile) return null;
  return { profileId: profile.id, role: profile.role, label: profile.display_name || profile.email || profile.id };
}

export type PublicIdentity = {
  id: string;
  connector_id: string;
  provider: string;
  profile_id: string;
  profile_label: string | null;
  display_name: string | null;
  external_user_hint: string;
  linked_at: string;
};

/** Active links: one profile's own, or (admin) the whole workspace. */
export async function listIdentities(input: { workspaceId: string; profileId?: string }): Promise<PublicIdentity[]> {
  const db = createAdminClient();
  let query = db
    .from("external_identities")
    .select("id, connector_id, provider, profile_id, display_name, external_user_id, linked_at")
    .eq("workspace_id", input.workspaceId)
    .is("revoked_at", null)
    .order("linked_at", { ascending: false });
  if (input.profileId) query = query.eq("profile_id", input.profileId);
  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as {
    id: string;
    connector_id: string;
    provider: string;
    profile_id: string;
    display_name: string | null;
    external_user_id: string;
    linked_at: string;
  }[];

  const labels = new Map<string, string>();
  const profileIds = [...new Set(rows.map((r) => r.profile_id))];
  if (profileIds.length > 0) {
    const { data: profiles } = await db
      .from("profiles")
      .select("id, display_name, email")
      .eq("workspace_id", input.workspaceId)
      .in("id", profileIds);
    for (const p of (profiles ?? []) as { id: string; display_name: string | null; email: string | null }[]) {
      labels.set(p.id, p.display_name || p.email || p.id);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    connector_id: r.connector_id,
    provider: r.provider,
    profile_id: r.profile_id,
    profile_label: labels.get(r.profile_id) ?? null,
    display_name: r.display_name,
    external_user_hint: maskExternalId(r.external_user_id),
    linked_at: r.linked_at,
  }));
}

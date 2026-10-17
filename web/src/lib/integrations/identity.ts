import { createHash, randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import type { Actor } from "@/lib/auth/guard";
import { sanitizeError } from "@/lib/integrations/secrets";
import { TENANT_MISMATCH_MESSAGE, maskExternalId, tenantMismatch } from "@/lib/integrations/store";
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

export { maskExternalId };

/**
 * `lark:<tenant>:<user>` with the tenant key and the open id MASKED: the value of
 * the `audit_log.external_actor_ref` column, which exists so a chat-originated
 * action stays traceable to the platform account that took it (together with the
 * connector and the platform's event id on the same row). The audit stream and
 * the table itself are readable by every workspace member, so the raw platform
 * ids are never stored there; nothing reads the column back to match on it.
 */
export function externalActorRef(provider: string, tenant: string, userId: string): string {
  return maskedExternalRef(provider, tenant, userId);
}

/** The reference with the tenant key and the open id masked (also used in audit `before`/`after`). */
export function maskedExternalRef(provider: string, tenant: string, userId: string): string {
  return `${provider}:${maskExternalId(tenant)}:${maskExternalId(userId)}`;
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

/** A link code is a 40-bit bearer secret, so guessing it is rate-limited per sender and per connector. */
export const LINK_ATTEMPT_WINDOW_SECONDS = 10 * 60;
export const LINK_ATTEMPTS_PER_SENDER = 8;
export const LINK_ATTEMPTS_PER_CONNECTOR = 120;

/** The bot's answer when a code is presented for a NoPM user who is already linked to another chat account. */
export const ALREADY_LINKED_MESSAGE =
  "This NoPM account is already linked to another Lark account. Unlink it in NoPM (Integrations) first, then send a new code.";

export type LinkOutcome =
  | {
      status: "linked";
      profileLabel: string;
      alreadyLinked: boolean;
      /** Platform accounts this link replaced (the adapter tells them), never including the new one. */
      displaced?: { externalTenant: string; externalUserId: string }[];
    }
  | { status: "rate_limited"; retryAfterSeconds: number }
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

  const budget = await linkAttemptBudget(connector, externalTenant, externalUserId);
  if (!budget.allowed) return { status: "rate_limited", retryAfterSeconds: budget.retryAfterSeconds };

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

    // A code never REPLACES an existing link. If the person is already linked to
    // another chat account, the account presenting the code is either them on a
    // new device (who can unlink in NoPM and send a fresh code) or someone who
    // got hold of a live code: silently moving the link would hand that holder
    // the owner's approvals. Refused BEFORE the pin, and the code is spent.
    const { data: held, error: heldError } = await db
      .from("external_identities")
      .select("id, external_tenant, external_user_id")
      .eq("workspace_id", connector.workspace_id)
      .eq("connector_id", connector.id)
      .eq("profile_id", profile.id)
      .is("revoked_at", null)
      .limit(1);
    if (heldError) throw heldError;
    const existing = ((held ?? []) as { id: string; external_tenant: string; external_user_id: string }[])[0];
    if (existing) {
      await refuseReplacement(connector, row.id, actor, existing, externalTenant, externalUserId);
      return { status: "conflict", message: ALREADY_LINKED_MESSAGE };
    }

    // Pin the tenant on the first NEW link (before the code is burned, so a
    // refused tenant leaves the code usable) — but only when an admin or manager
    // is linking. Any member can mint a code, so letting a viewer's first link
    // pin the connector would let one person lock the real tenant out by
    // linking from a foreign one. A non-approver's link still works (it grants
    // nothing by itself); it just does not decide which tenant is trusted.
    if (profile.role === "admin" || profile.role === "manager") {
      const pin = await pinTenant(connector, externalTenant);
      if (pin === "mismatch") return { status: "forbidden", message: TENANT_MISMATCH_MESSAGE };
      pinnedHere = pin === "pinned";
    } else if (connector.tenant_key && connector.tenant_key !== externalTenant) {
      return { status: "forbidden", message: TENANT_MISMATCH_MESSAGE };
    }

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

    try {
      await writeAudit({
        workspaceId: connector.workspace_id,
        actor,
        action: "integration.identity.link",
        targetType: "external_identity",
        targetId: inserted.id,
        // Masked: the audit stream is readable by every member.
        before: replacedRows.length
          ? { external_ref: maskedExternalRef(connector.kind, replacedRows[0].external_tenant, replacedRows[0].external_user_id) }
          : null,
        after: {
          connector_id: connector.id,
          provider: connector.kind,
          profile_id: profile.id,
          external_ref: maskedExternalRef(connector.kind, externalTenant, externalUserId),
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

    // A code replaced the person's earlier link. A leaked or phished code could
    // do exactly this, so the person is told on both sides: in NoPM, and on the
    // Lark account that just lost its link (the adapter sends that DM).
    const displaced = replacedRows
      .filter((r) => !(r.external_tenant === externalTenant && r.external_user_id === externalUserId))
      .map((r) => ({ externalTenant: r.external_tenant, externalUserId: r.external_user_id }));
    if (displaced.length > 0) await notifyLinkReplaced(connector, profile.id);

    return { status: "linked", profileLabel: label, alreadyLinked: false, ...(displaced.length > 0 ? { displaced } : {}) };
  } catch (err) {
    console.error("[integrations] link code consume failed:", sanitizeError(err));
    return { status: "error", message: "Could not link your account right now. Please try again." };
  } finally {
    // Any exit that did not complete the link releases a pin taken for it.
    if (pinnedHere && !completed) await releasePin(connector, externalTenant).catch(() => {});
  }
}

/**
 * A code was presented for a user who already holds a link: spend the code and
 * record the refused attempt (`integration.identity.link.blocked`, the code
 * owner as actor, ids masked like every audit row the members can read). The
 * record is best effort: a refusal changes nothing, so a failing audit write
 * must not turn it into an error reply.
 */
async function refuseReplacement(
  connector: ConnectorRow,
  codeId: string,
  actor: Actor,
  existing: { id: string; external_tenant: string; external_user_id: string },
  externalTenant: string,
  externalUserId: string,
): Promise<void> {
  const db = createAdminClient();
  const nowIso = new Date().toISOString();
  try {
    const { error } = await db
      .from("identity_link_codes")
      .update({ used_at: nowIso })
      .eq("id", codeId)
      .eq("workspace_id", connector.workspace_id)
      .is("used_at", null);
    if (error) throw error;
    await writeAudit({
      workspaceId: connector.workspace_id,
      actor,
      action: "integration.identity.link.blocked",
      targetType: "external_identity",
      targetId: existing.id,
      before: null,
      after: {
        connector_id: connector.id,
        provider: connector.kind,
        profile_id: actor.id,
        reason: "profile_already_linked",
        external_ref: maskedExternalRef(connector.kind, externalTenant, externalUserId),
        existing_external_ref: maskedExternalRef(connector.kind, existing.external_tenant, existing.external_user_id),
      },
    });
  } catch (err) {
    console.error("[integrations] could not record a refused link:", sanitizeError(err));
  }
}

/**
 * Count one link attempt against the sender's budget and the connector's, in a
 * 10-minute fixed window (the shared `nopm_rate_check` counter). Keys hold a
 * hash, never the platform ids. Fail-CLOSED on an infrastructure error (F5): the
 * code is a 40-bit single-use bearer secret and this counter is its only throttle,
 * so a broken limiter must not become an unlimited one.
 */
async function linkAttemptBudget(
  connector: Pick<ConnectorRow, "id">,
  externalTenant: string,
  externalUserId: string,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const db = createAdminClient();
  const sender = createHash("sha256").update(`${externalTenant}\n${externalUserId}`).digest("hex").slice(0, 32);
  const checks: [string, number][] = [
    [`lark-link:${connector.id}:${sender}`, LINK_ATTEMPTS_PER_SENDER],
    [`lark-link-conn:${connector.id}`, LINK_ATTEMPTS_PER_CONNECTOR],
  ];
  for (const [key, max] of checks) {
    const { data, error } = await db.rpc("nopm_rate_check", {
      p_key: key,
      p_max: max,
      p_window_seconds: LINK_ATTEMPT_WINDOW_SECONDS,
    });
    if (error) {
      // A link code is a 40-bit bearer secret and this counter is its only throttle, so an
      // infrastructure error refuses the attempt (like the webhook and relay limiters) rather than
      // letting an unthrottled guess through. A genuine user simply retries a moment later.
      console.error("[integrations] nopm_rate_check RPC failed - FAILING CLOSED (link attempt refused)", { error: error.message });
      return { allowed: false, retryAfterSeconds: 30 };
    }
    const result = data as { allowed: boolean; retry_after_seconds: number };
    if (!result.allowed) return { allowed: false, retryAfterSeconds: result.retry_after_seconds };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** In-app notice to the profile whose link was just replaced. Fail-soft: it never undoes the link. */
async function notifyLinkReplaced(connector: Pick<ConnectorRow, "id" | "workspace_id">, profileId: string): Promise<void> {
  try {
    const { error } = await createAdminClient().from("notifications").insert({
      workspace_id: connector.workspace_id,
      recipient_id: profileId,
      type: "integration.link_replaced",
      title: "Your Lark account link was changed",
      body: "A link code linked a different Lark account to your NoPM user, and the earlier one was unlinked. If that was not you, unlink it under Integrations and tell an admin.",
      payload: { connector_id: connector.id },
    });
    if (error) console.error("[integrations] link-replaced notice failed:", sanitizeError(error));
  } catch (err) {
    console.error("[integrations] link-replaced notice failed:", sanitizeError(err));
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

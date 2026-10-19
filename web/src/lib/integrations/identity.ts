import { createHash, randomBytes } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildRpcAudit } from "@/lib/audit/sql-audit-insert";
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
 * the CODE OWNER as actor and `channel='lark'`.
 *
 * ONE database function does the whole link (migration 0109, R-164d,
 * nopm_link_identity): consume the code, revoke the profile's previous link,
 * insert the identity, pin the tenant and write the audit row in a single
 * transaction. If any step fails nothing is kept, so a consumed code with no
 * identity cannot exist and there is no compensating code here.
 *
 * Tenant pin: the FIRST successful link by an admin or manager pins the
 * connector to the event's tenant (the connector row is locked, so of two
 * tenants racing to link first exactly one wins); from then on a code consumed
 * from any other tenant is refused with `forbidden` and left unburned. The
 * pin is recorded in the audit row (`after.tenant_pinned`).
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

  try {
    const db = createAdminClient();
    const codeHash = hashLinkCode(code);

    // Fast paths only: the database function re-checks all of this under lock.
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

    // The whole link in one transaction. Conflict checks run before the code is burned, so a refused link
    // leaves the code usable for a corrected attempt; a profile that already holds a link has the code spent
    // and the refusal recorded (integration.identity.link.blocked), inside the function.
    const { data, error } = await db.rpc("nopm_link_identity", {
      p_workspace_id: connector.workspace_id,
      p_connector_id: connector.id,
      p_code_hash: codeHash,
      p_profile_id: profile.id,
      p_external_tenant: externalTenant,
      p_external_user_id: externalUserId,
      p_external_union_id: input.externalUnionId ?? null,
      p_display_name: input.displayName ?? null,
      // Masked ids live in before/after (built in SQL); the actor keeps the full reference.
      p_audit: buildRpcAudit(actor, "integration.identity.link", "external_identity"),
    });
    if (error) throw error;
    return mapLinkResult(data as LinkRpcResult | null, label, connector, profile.id);
  } catch (err) {
    console.error("[integrations] link code consume failed:", sanitizeError(err));
    return { status: "error", message: "Could not link your account right now. Please try again." };
  }
}

type LinkRpcResult = {
  status?: string;
  reason?: string;
  already_linked?: boolean;
  profile_label?: string;
  displaced?: { external_tenant: string; external_user_id: string }[];
};

/** Turn nopm_link_identity's answer into the adapter-facing outcome (and send the replaced-link notice). */
async function mapLinkResult(
  r: LinkRpcResult | null,
  label: string,
  connector: Pick<ConnectorRow, "id" | "workspace_id">,
  profileId: string,
): Promise<LinkOutcome> {
  switch (r?.status) {
    case "paused":
      return { status: "paused" };
    case "invalid_code":
      return { status: "invalid_code" };
    case "already_used":
      return { status: "already_used" };
    case "expired":
      return { status: "expired" };
    case "forbidden":
      return { status: "forbidden", message: TENANT_MISMATCH_MESSAGE };
    case "conflict":
      if (r.reason === "already_linked") return { status: "conflict", message: ALREADY_LINKED_MESSAGE };
      if (r.reason === "duplicate") {
        return { status: "conflict", message: "This account is already linked. Unlink it first, then try again." };
      }
      return {
        status: "conflict",
        message: "This account is already linked to another NoPM user. Ask them (or an admin) to unlink it first.",
      };
    case "linked": {
      if (r.already_linked) return { status: "linked", profileLabel: label, alreadyLinked: true };
      // A code replaced the person's earlier link. A leaked or phished code could do exactly this, so the
      // person is told on both sides: in NoPM, and on the Lark account that just lost its link (the adapter
      // sends that DM).
      const displaced = (r.displaced ?? []).map((d) => ({ externalTenant: d.external_tenant, externalUserId: d.external_user_id }));
      if (displaced.length > 0) await notifyLinkReplaced(connector, profileId);
      return { status: "linked", profileLabel: label, alreadyLinked: false, ...(displaced.length > 0 ? { displaced } : {}) };
    }
    default:
      return { status: "error", message: "Could not link your account right now. Please try again." };
  }
}

/**
 * Count one link attempt against the sender's budget and the connector's, in a
 * 10-minute fixed window (the shared `nopm_rate_check` counter). Keys hold a
 * hash, never the platform ids. Fail-OPEN on an infrastructure error: an abuse
 * guard, not an auth control — the code itself is 40 bits and single use.
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
      console.error("[integrations] nopm_rate_check RPC failed - FAILING OPEN (link attempts not limited this call)", { error: error.message });
      return { allowed: true, retryAfterSeconds: 0 };
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

import { createAdminClient } from "@/lib/supabase/admin";
import { ApiError, NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { hashToken } from "@/lib/auth/tokens";
import type { Actor } from "@/lib/auth/guard";
import { decideApproval } from "@/lib/governance/decide";
import { externalActorRef } from "@/lib/integrations/identity";
import { sanitizeError } from "@/lib/integrations/secrets";
import { TENANT_MISMATCH_MESSAGE, tenantMismatch } from "@/lib/integrations/store";
import type { ApprovalKind, ConnectorRow, InboundOutcome } from "@/lib/integrations/types";

/**
 * The ONLY inbound mutation the hub performs: a human, identity-verified,
 * single-use approve/reject on a governed request that already exists (D8).
 *
 * Pipeline (every step fails to a TYPED outcome — this function never throws
 * to the platform; the adapter turns the outcome into a toast + card):
 *
 *   kill switch (connector active?) -> idempotency claim (unique connector +
 *   external event id; a replay returns the stored outcome) -> verified
 *   platform user -> ACTIVE external_identities row -> profile in the SAME
 *   workspace -> atomically consume the action token (unused, unexpired,
 *   recipient = this profile) -> build the Actor -> decideApproval (the same
 *   governed code path the REST routes use: four-eyes by HUMAN principal,
 *   scopes, locks, the single audit row with channel='lark') -> store outcome.
 *
 * Trust boundary: the ONLY identity input is the platform-verified
 * (tenant, user id) the adapter extracted after checking the callback's
 * signature. The card payload contributes just an opaque token + the action;
 * which request the click targets comes from the token's own row, never from
 * the payload, so a forged or tampered card cannot redirect a decision.
 */
export type ApprovalActionInput = {
  connector: ConnectorRow;
  /** The platform's event / callback id — the idempotency key. */
  externalEventId: string;
  externalTenant: string;
  externalUserId: string;
  /** The raw token from the card's button value. */
  actionToken: string;
  action: "approve" | "reject";
  /** Required (non-empty) for reject. */
  note?: string | null;
};

/** A claim with no outcome older than this is a crashed run and may be retaken. */
const STALE_CLAIM_MS = 60_000;

type TokenRow = {
  id: string;
  recipient_profile_id: string;
  approval_kind: ApprovalKind;
  approval_id: string;
  used_at: string | null;
  expires_at: string;
};

export async function handleApprovalAction(input: ApprovalActionInput): Promise<InboundOutcome> {
  const { connector } = input;
  let claimId: string | null = null;
  let tokenId: string | null = null;

  try {
    // ── validate + kill switch (no side effects yet) ────────────────────────
    if (connector.status !== "active") {
      return { status: "forbidden", message: "This integration is paused by your workspace admin." };
    }
    // Pinned to one platform tenant: an event from any other tenant is refused
    // outright, before a claim, an identity lookup or a token is touched.
    if (tenantMismatch(connector, input.externalTenant)) {
      return { status: "forbidden", message: TENANT_MISMATCH_MESSAGE };
    }
    if (input.action !== "approve" && input.action !== "reject") {
      return { status: "invalid", message: "Unknown action." };
    }
    if (!input.externalEventId?.trim() || !input.actionToken?.trim()) {
      return { status: "invalid", message: "This approval link isn't valid." };
    }
    const note = input.note?.trim() || undefined;
    if (input.action === "reject" && !note) {
      return { status: "invalid", message: "A reason is required to reject." };
    }

    const db = createAdminClient();
    const workspaceId = connector.workspace_id;

    // ── idempotency claim ───────────────────────────────────────────────────
    const claim = await claimEvent(connector, input.externalEventId, input.action);
    if ("replay" in claim) return claim.replay;
    claimId = claim.id;

    // ── identity ────────────────────────────────────────────────────────────
    const { data: identity, error: identityError } = await db
      .from("external_identities")
      .select("id, profile_id")
      .eq("workspace_id", workspaceId)
      .eq("connector_id", connector.id)
      .eq("external_tenant", input.externalTenant)
      .eq("external_user_id", input.externalUserId)
      .is("revoked_at", null)
      .maybeSingle();
    if (identityError) throw identityError;
    if (!identity) return await finish(claimId, { status: "unlinked" });

    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("id, role, display_name, email")
      .eq("id", identity.profile_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile) return await finish(claimId, { status: "unlinked" });
    // Cards only ever go to admins/managers (resolveWorkspaceApprovers); a
    // person demoted since the card was sent must not keep approving from it.
    if (profile.role !== "admin" && profile.role !== "manager") {
      return await finish(
        claimId,
        { status: "forbidden", message: "Only workspace admins and managers can approve or reject from chat." },
        { principalId: profile.id },
      );
    }

    // ── single-use, recipient-bound, approval-bound action token ────────────
    const tokenHash = hashToken(input.actionToken.trim());
    const nowIso = new Date().toISOString();
    const { data: consumed, error: consumeError } = await db
      .from("action_tokens")
      .update({ used_at: nowIso })
      .eq("token_hash", tokenHash)
      .eq("workspace_id", workspaceId)
      .eq("recipient_profile_id", profile.id)
      .is("used_at", null)
      .gt("expires_at", nowIso)
      .select("id, recipient_profile_id, approval_kind, approval_id, used_at, expires_at");
    if (consumeError) throw consumeError;

    if (!consumed || consumed.length === 0) {
      const denied = await classifyTokenFailure(workspaceId, tokenHash, profile.id);
      return await finish(claimId, denied, { principalId: profile.id });
    }
    const token = consumed[0] as TokenRow;
    tokenId = token.id;
    const ref = { kind: token.approval_kind, id: token.approval_id };

    // ── the governed decision ───────────────────────────────────────────────
    const actor: Actor = {
      type: "user",
      id: profile.id,
      principalId: profile.id,
      label: profile.display_name || profile.email || profile.id,
      workspaceId,
      role: profile.role,
      channel: "lark",
      viaConnectorId: connector.id,
      externalEventId: input.externalEventId,
      externalActorRef: externalActorRef(connector.kind, input.externalTenant, input.externalUserId),
      requestId: crypto.randomUUID(),
    };

    let outcome: InboundOutcome;
    try {
      const result = await decideApproval(actor, ref, input.action, note);
      outcome = {
        status: "decided",
        action: input.action,
        ref,
        title: result.title,
        newStatus: result.status,
      };
    } catch (err) {
      outcome = mapDecisionError(err);
    }

    // A failure that did not decide anything for a reason the recipient can
    // fix (a transient error, a lock they can lift) must not burn the card.
    if (outcome.status === "error" || outcome.status === "invalid") {
      await releaseToken(tokenId, workspaceId);
    }
    if (outcome.status === "error") {
      // Don't memoise a transient failure: let the platform's retry re-run it.
      await dropClaim(claimId, workspaceId);
      claimId = null;
      return outcome;
    }
    return await finish(claimId, outcome, { principalId: profile.id, ref });
  } catch (err) {
    console.error("[integrations] inbound action failed:", sanitizeError(err));
    if (tokenId) await releaseToken(tokenId, connector.workspace_id).catch(() => {});
    if (claimId) await dropClaim(claimId, connector.workspace_id).catch(() => {});
    return { status: "error", message: "Something went wrong. Please try again, or decide this in NoPM." };
  }
}

/** Map what decideApproval throws onto a typed outcome the adapter can render. */
export function mapDecisionError(err: unknown): InboundOutcome {
  // The governed code attaches a stable `code`; branch on it first and fall
  // back to the message only for errors thrown without one.
  if (err instanceof ApiError) {
    switch (err.code) {
      case "self_approval":
        return { status: "self_approval" };
      case "no_principal":
        return { status: "forbidden", message: err.message };
      case "already_decided":
        return { status: "already_decided" };
      case "rationale_required":
        return { status: "invalid", message: "A reason is required to reject." };
    }
  }
  if (err instanceof ScopeError) {
    if (/four-eyes|self-approv|own request/i.test(err.message)) return { status: "self_approval" };
    return { status: "forbidden", message: err.message };
  }
  if (err instanceof RuleError) {
    if (/already (been )?decided|already (approved|rejected|committed|withdrawn)/i.test(err.message)) {
      return { status: "already_decided" };
    }
    return { status: "invalid", message: err.message };
  }
  if (err instanceof NotFoundError) {
    return { status: "invalid", message: "That request no longer exists." };
  }
  if (err instanceof ApiError && err.status < 500) {
    return { status: "invalid", message: err.message };
  }
  console.error("[integrations] decideApproval failed:", sanitizeError(err));
  return { status: "error", message: "Something went wrong. Please try again, or decide this in NoPM." };
}

async function classifyTokenFailure(
  workspaceId: string,
  tokenHash: string,
  profileId: string,
): Promise<InboundOutcome> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("action_tokens")
    .select("id, recipient_profile_id, approval_kind, approval_id, used_at, expires_at")
    .eq("token_hash", tokenHash)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  const row = data as TokenRow | null;
  if (!row) return { status: "invalid", message: "This approval link isn't valid." };
  if (row.recipient_profile_id !== profileId) return { status: "not_recipient" };
  // Used covers both "I already clicked" and "decided from another channel"
  // (a decision stamps every open token of the request as used).
  if (row.used_at) return { status: "already_decided" };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { status: "expired" };
  // Valid and unused yet the conditional consume matched nothing: lost a race.
  return { status: "already_decided" };
}

// ── idempotency ledger ─────────────────────────────────────────────────────

async function claimEvent(
  connector: ConnectorRow,
  externalEventId: string,
  action: "approve" | "reject",
): Promise<{ id: string } | { replay: InboundOutcome }> {
  const db = createAdminClient();
  const insert = () =>
    db
      .from("inbound_actions")
      .insert({
        workspace_id: connector.workspace_id,
        connector_id: connector.id,
        external_event_id: externalEventId,
        action,
      })
      .select("id")
      .single();

  const first = await insert();
  if (!first.error && first.data) return { id: first.data.id };
  if (first.error?.code !== "23505") throw first.error ?? new Error("Claim insert returned no row");

  const stored = await readClaim(connector, externalEventId);
  if (stored?.outcome) return { replay: stored.outcome };

  // In flight (or crashed): a fresh claim is retaken only once it is stale.
  if (stored && Date.now() - new Date(stored.received_at).getTime() > STALE_CLAIM_MS) {
    await dropClaim(stored.id, connector.workspace_id);
    const retry = await insert();
    if (!retry.error && retry.data) return { id: retry.data.id };
    const again = await readClaim(connector, externalEventId);
    if (again?.outcome) return { replay: again.outcome };
  }
  return { replay: { status: "error", message: "This action is already being processed." } };
}

async function readClaim(
  connector: ConnectorRow,
  externalEventId: string,
): Promise<{ id: string; outcome: InboundOutcome | null; received_at: string } | null> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("inbound_actions")
    .select("id, outcome, received_at")
    .eq("workspace_id", connector.workspace_id)
    .eq("connector_id", connector.id)
    .eq("external_event_id", externalEventId)
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string; outcome: InboundOutcome | null; received_at: string } | null) ?? null;
}

/** Record the typed outcome on the claim and return it. */
async function finish(
  claimId: string,
  outcome: InboundOutcome,
  extra: { principalId?: string; ref?: { kind: ApprovalKind; id: string } } = {},
): Promise<InboundOutcome> {
  const db = createAdminClient();
  const { error } = await db
    .from("inbound_actions")
    .update({
      outcome,
      ...(extra.principalId ? { principal_id: extra.principalId } : {}),
      ...(extra.ref ? { approval_kind: extra.ref.kind, approval_id: extra.ref.id } : {}),
    })
    .eq("id", claimId);
  if (error) console.error("[integrations] failed to store inbound outcome:", sanitizeError(error));
  return outcome;
}

async function dropClaim(claimId: string, workspaceId: string): Promise<void> {
  const db = createAdminClient();
  await db.from("inbound_actions").delete().eq("id", claimId).eq("workspace_id", workspaceId).is("outcome", null);
}

async function releaseToken(tokenId: string, workspaceId: string): Promise<void> {
  const db = createAdminClient();
  await db.from("action_tokens").update({ used_at: null }).eq("id", tokenId).eq("workspace_id", workspaceId);
}

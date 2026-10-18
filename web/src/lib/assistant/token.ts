/**
 * Mint and revoke ephemeral API tokens for the assistant.
 * Each turn creates one short-lived api_tokens row (TTL = the longest a turn can run).
 * The row is marked `kind = 'assistant'` (migration 0052); that column — never
 * the name, which a manager can type — is what hides it from the human Tokens
 * list. The name "AI Assistant · <user>" is a label only.
 */

export const runtime = "nodejs";

import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateToken } from "@/lib/auth/tokens";
import { auditedInsert, auditedUpdate } from "@/lib/audit/audited-write";
import type { Actor } from "@/lib/auth/guard";
import { TOOL_SCOPES } from "./tools";

/**
 * How long an ephemeral token can live. A turn is bounded (6 provider steps, 8
 * tool calls, each under the platform timeout), so 10 minutes covers the longest
 * turn; the explicit revoke on every path (A1-10) is the real control and the TTL
 * is only the backstop for a process that dies before it can run.
 */
export const EPHEMERAL_TOKEN_TTL_MS = 10 * 60 * 1000;

/** Which turn a token belongs to; written on the mint and revoke audit rows (A3-14). */
export type TokenAuditContext = {
  conversationId?: string | null;
};

export type EphemeralToken = {
  raw: string;
  id: string;
};

/**
 * Scopes the ephemeral token may carry, derived from the session user's
 * role. Viewers are read-only everywhere else in NoPM (requireScope blocks
 * any non-read action for them) — the assistant must not become a side door
 * that lets a viewer's chat turn perform writes through a token actor.
 */
export function scopesForActor(actor: Actor): string[] {
  if (actor.role === "viewer") {
    return TOOL_SCOPES.filter((s) => s.endsWith(":read"));
  }
  return [...TOOL_SCOPES];
}

/**
 * Mint a real api_tokens row scoped to the assistant tool set.
 * Caller MUST call revokeEphemeralToken(id) in a finally block.
 *
 * `created_by` records the HUMAN the assistant is acting for (the signed-in
 * user's profile id). Four-eyes compares humans, not actor ids, so the token's
 * owner is what makes "the assistant requested it, the same person can't
 * approve it" hold; a token minted without one could never approve anything
 * (fail-closed) and would hide whose request it was.
 */
export async function mintEphemeralToken(actor: Actor, ctx: TokenAuditContext = {}): Promise<EphemeralToken> {
  const { raw, hash, prefix } = generateToken();
  const scopes = scopesForActor(actor);
  const expiresAt = new Date(Date.now() + EPHEMERAL_TOKEN_TTL_MS).toISOString();

  // ONE database function (nopm_mutate_audited, migration 0103): the token row and its mint audit row are one
  // transaction, so a token that cannot be audited is never created (A3-14, fail-closed). The row id is chosen
  // here so the audit row can name it; the token hash is written but kept out of the audit row and out of the
  // returned row (omitColumns).
  const id = randomUUID();
  const conversationId = ctx.conversationId ?? null;
  try {
    await auditedInsert({
      table: "api_tokens",
      actor,
      id,
      patch: {
        name: `AI Assistant · ${actor.label}`,
        token_hash: hash,
        prefix,
        scopes,
        // The reliable marker (0052). Only this mint path sets it; POST /api/tokens cannot.
        kind: "assistant",
        created_by: actor.principalId ?? (actor.type === "user" ? actor.id : null),
        expires_at: expiresAt,
      },
      action: "assistant.token.mint",
      targetType: "assistant_conversation",
      // With no conversation the audit target falls back to the token row itself.
      auditTargetId: conversationId ?? undefined,
      auditBefore: null,
      auditAfter: { token_id: id, conversation_id: conversationId, scopes, expires_at: expiresAt },
      omitColumns: ["token_hash"],
    });
  } catch (err) {
    throw new Error(`Failed to mint ephemeral assistant token: ${(err as { message?: string } | null)?.message ?? "unknown"}`);
  }

  return { raw, id };
}

/**
 * Revoke (set revoked=true) the ephemeral token by id and, when the actor is known, write the revoke audit row
 * in the SAME transaction (A3-14). A revoke must never be skipped because its audit write failed: if the
 * audited revoke errors, the token is revoked without it and the failure is logged loudly. Best-effort overall:
 * a finally block must never throw.
 */
export async function revokeEphemeralToken(
  id: string,
  ctx: (TokenAuditContext & { actor?: Actor }) = {},
): Promise<void> {
  const conversationId = ctx.conversationId ?? null;
  if (ctx.actor) {
    try {
      await auditedUpdate({
        table: "api_tokens",
        actor: ctx.actor,
        id,
        patch: { revoked: true },
        action: "assistant.token.revoke",
        targetType: "assistant_conversation",
        auditTargetId: conversationId ?? undefined,
        auditBefore: null,
        auditAfter: { token_id: id, conversation_id: conversationId },
        omitColumns: ["token_hash"],
      });
      return;
    } catch (err) {
      console.error("[assistant] audited revoke of the ephemeral token failed; revoking without the audit row", id, err);
    }
  }
  try {
    let query = createAdminClient().from("api_tokens").update({ revoked: true }).eq("id", id);
    if (ctx.actor) query = query.eq("workspace_id", ctx.actor.workspaceId);
    await query;
  } catch (err) {
    console.error("[assistant] failed to revoke ephemeral token", id, err);
  }
}

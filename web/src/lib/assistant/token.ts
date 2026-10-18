/**
 * Mint and revoke ephemeral API tokens for the assistant.
 * Each turn creates one short-lived api_tokens row (TTL = the longest a turn can run).
 * The row is marked `kind = 'assistant'` (migration 0052); that column — never
 * the name, which a manager can type — is what hides it from the human Tokens
 * list. The name "AI Assistant · <user>" is a label only.
 */

export const runtime = "nodejs";

import { createAdminClient } from "@/lib/supabase/admin";
import { generateToken } from "@/lib/auth/tokens";
import { writeAudit } from "@/lib/audit/write";
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

  const db = createAdminClient();
  const { data: row, error } = await db
    .from("api_tokens")
    .insert({
      workspace_id: actor.workspaceId,
      name: `AI Assistant · ${actor.label}`,
      token_hash: hash,
      prefix,
      scopes,
      // The reliable marker (0052). Only this mint path sets it; POST /api/tokens cannot.
      kind: "assistant",
      created_by: actor.principalId ?? (actor.type === "user" ? actor.id : null),
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (error || !row) {
    throw new Error(`Failed to mint ephemeral assistant token: ${error?.message ?? "unknown"}`);
  }

  // A3-14: one audit row per mint, linked to the conversation. Fail-closed: a
  // token that cannot be audited is revoked at once and the turn does not run.
  try {
    await writeAudit({
      workspaceId: actor.workspaceId,
      actor,
      action: "assistant.token.mint",
      targetType: "assistant_conversation",
      targetId: ctx.conversationId ?? null,
      before: null,
      after: { token_id: row.id, conversation_id: ctx.conversationId ?? null, scopes, expires_at: expiresAt },
    });
  } catch (err) {
    await db.from("api_tokens").update({ revoked: true }).eq("id", row.id);
    throw err;
  }

  return { raw, id: row.id };
}

/**
 * Revoke (set revoked=true) the ephemeral token by id.
 * Best-effort — logs on failure but does not throw.
 */
export async function revokeEphemeralToken(
  id: string,
  ctx: (TokenAuditContext & { actor?: Actor }) = {},
): Promise<void> {
  try {
    const db = createAdminClient();
    await db.from("api_tokens").update({ revoked: true }).eq("id", id);
  } catch (err) {
    console.error("[assistant] failed to revoke ephemeral token", id, err);
    return;
  }
  // A3-14: one audit row per revoke. Fail-soft (the token is already dead and a
  // finally block must never throw), but loud.
  if (!ctx.actor) return;
  try {
    await writeAudit({
      workspaceId: ctx.actor.workspaceId,
      actor: ctx.actor,
      action: "assistant.token.revoke",
      targetType: "assistant_conversation",
      targetId: ctx.conversationId ?? null,
      before: null,
      after: { token_id: id, conversation_id: ctx.conversationId ?? null },
    });
  } catch (err) {
    console.error("[assistant] failed to audit ephemeral token revoke", id, err);
  }
}

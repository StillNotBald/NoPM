/**
 * Mint and revoke ephemeral API tokens for the assistant.
 * Each turn creates one short-lived api_tokens row (1 hour TTL).
 * The token's name starts with "AI Assistant · " so it is filtered
 * out of the human Tokens list.
 */

export const runtime = "nodejs";

import { createAdminClient } from "@/lib/supabase/admin";
import { generateToken } from "@/lib/auth/tokens";
import type { Actor } from "@/lib/auth/guard";
import { TOOL_SCOPES } from "./tools";

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
export async function mintEphemeralToken(actor: Actor): Promise<EphemeralToken> {
  const { raw, hash, prefix } = generateToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1 hour

  const db = createAdminClient();
  const { data: row, error } = await db
    .from("api_tokens")
    .insert({
      workspace_id: actor.workspaceId,
      name: `AI Assistant · ${actor.label}`,
      token_hash: hash,
      prefix,
      scopes: scopesForActor(actor),
      created_by: actor.principalId ?? (actor.type === "user" ? actor.id : null),
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (error || !row) {
    throw new Error(`Failed to mint ephemeral assistant token: ${error?.message ?? "unknown"}`);
  }

  return { raw, id: row.id };
}

/**
 * Revoke (set revoked=true) the ephemeral token by id.
 * Best-effort — logs on failure but does not throw.
 */
export async function revokeEphemeralToken(id: string): Promise<void> {
  try {
    const db = createAdminClient();
    await db.from("api_tokens").update({ revoked: true }).eq("id", id);
  } catch (err) {
    console.error("[assistant] failed to revoke ephemeral token", id, err);
  }
}

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
 * Mint a real api_tokens row scoped to the assistant tool set.
 * Caller MUST call revokeEphemeralToken(id) in a finally block.
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
      scopes: [...TOOL_SCOPES],
      created_by: actor.id,
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

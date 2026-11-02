/**
 * Per-action scoped tokens for chat writes (ADR 0020, decision 9).
 *
 * One write from Telegram = one short-lived `api_tokens` row (kind `telegram`,
 * created_by = the linked human, scopes = exactly what that call needs), used
 * for one REST call and revoked straight after. The REST route then writes the
 * governed record and its single audit row on channel `telegram` (the channel is
 * derived from the token kind in lib/auth/guard.ts, never from a header).
 *
 * Mint and revoke are themselves audited, in the same transaction as the token
 * row (nopm_mutate_audited), like the assistant's ephemeral tokens. If the mint
 * cannot be audited, no token exists and the action fails.
 */

import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateToken } from "@/lib/auth/tokens";
import { auditedInsert, auditedUpdate } from "@/lib/audit/audited-write";
import { writeAudit } from "@/lib/audit/write";
import type { Actor } from "@/lib/auth/guard";
import type { LinkedProfile } from "@/lib/integrations/identity";
import type { ConnectorRow } from "@/lib/integrations/types";
import { TOOL_SCOPES } from "@/lib/assistant/tools";

/** A step is one REST call; a minute or two is plenty and the revoke is the real control. */
export const ACTION_TOKEN_TTL_MS = 2 * 60 * 1000;

/** Scopes a chat token may ever carry. Wildcards and admin scopes are not on the list. */
const WRITE_SCOPES = new Set([
  "task:write",
  "issue:write",
  "risk:write",
  "task:delete:request",
]);
/**
 * Read scopes of the assistant's own ceiling (every `:read` in TOOL_SCOPES). A free-text turn (ADR 0020,
 * "Free-text mode") may carry these and nothing else: no write, no delete-request, no approve, no admin.
 */
export const FREE_TEXT_READ_SCOPES: readonly string[] = TOOL_SCOPES.filter((s) => s.endsWith(":read"));
const READ_SCOPES = new Set(["task:read", "project:read", "issue:read", "risk:read", ...FREE_TEXT_READ_SCOPES]);
/** The single privileged scope a tap in /4 may carry: `<target>:delete:approve` for the tapped request. */
const APPROVE_SCOPE_RE = /^(task|project|risk|issue|expense|document|milestone):delete:approve$/;

/** True when every scope only reads. Such a token is audited once (the mint); its revoke adds no second row. */
export function isReadOnlyScopes(scopes: readonly string[]): boolean {
  return scopes.length > 0 && scopes.every((s) => READ_SCOPES.has(s));
}

export class ScopeNotAllowedError extends Error {}

/** Throws unless every scope is on the allow-list (a lone approve scope is allowed only on its own). */
export function assertAllowedScopes(scopes: readonly string[]): void {
  if (scopes.length === 0) throw new ScopeNotAllowedError("A chat token needs at least one scope");
  if (scopes.length === 1 && APPROVE_SCOPE_RE.test(scopes[0])) return;
  for (const s of scopes) {
    if (!WRITE_SCOPES.has(s) && !READ_SCOPES.has(s)) throw new ScopeNotAllowedError(`Scope not allowed for a chat token: ${s}`);
  }
}

export function chatActor(connector: ConnectorRow, profile: LinkedProfile): Actor {
  return {
    type: "user",
    id: profile.profileId,
    principalId: profile.profileId,
    label: profile.label,
    workspaceId: connector.workspace_id,
    role: profile.role,
    principalRole: profile.role,
    channel: "telegram",
    viaConnectorId: connector.id,
  };
}

export type ActionToken = { raw: string; id: string };

export async function mintActionToken(connector: ConnectorRow, profile: LinkedProfile, scopes: string[], opts: { ttlMs?: number } = {}): Promise<ActionToken> {
  assertAllowedScopes(scopes);
  const actor = chatActor(connector, profile);
  const { raw, hash, prefix } = generateToken();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + (opts.ttlMs ?? ACTION_TOKEN_TTL_MS)).toISOString();
  await auditedInsert({
    table: "api_tokens",
    actor,
    id,
    patch: {
      name: `Telegram · ${profile.label}`.slice(0, 100),
      token_hash: hash,
      prefix,
      scopes,
      kind: "telegram",
      created_by: profile.profileId,
      expires_at: expiresAt,
    },
    action: "telegram.token.mint",
    targetType: "telegram_action",
    auditTargetId: id,
    auditBefore: null,
    auditAfter: { token_id: id, scopes, expires_at: expiresAt, connector_id: connector.id },
    omitColumns: ["token_hash"],
  });
  return { raw, id };
}

/**
 * Never throws: a finally block must not hide the real result.
 *
 * Audit shape (matches the web assistant, which audits the mint and the revoke of its ephemeral token):
 *   - a write token: mint row + revoke row (+ the governed write's own row);
 *   - a read-only token (`audit: false`): the mint row only. Reads are not audited elsewhere in NoPM, and the
 *     revoke of a read-only token changes nothing a reader could rely on, so it does not add a second row.
 * If the audited revoke fails, the token is still killed with a plain update (security over audit for a
 * 2-minute token) AND a fallback audit row `telegram.token.revoke` (after.fallback = true) is written; a failure
 * of that row is logged loudly, never silent.
 */
export async function revokeActionToken(connector: ConnectorRow, profile: LinkedProfile, id: string, opts: { audit?: boolean } = {}): Promise<void> {
  const audit = opts.audit !== false;
  const db = () => createAdminClient().from("api_tokens").update({ revoked: true }).eq("id", id).eq("workspace_id", connector.workspace_id);
  if (!audit) {
    try {
      await db();
    } catch (err) {
      console.error("[nopm][telegram] failed to revoke read-only action token", id, err instanceof Error ? err.message : "unknown");
    }
    return;
  }
  try {
    await auditedUpdate({
      table: "api_tokens",
      actor: chatActor(connector, profile),
      id,
      patch: { revoked: true },
      action: "telegram.token.revoke",
      targetType: "telegram_action",
      auditTargetId: id,
      auditBefore: null,
      auditAfter: { token_id: id, connector_id: connector.id },
      omitColumns: ["token_hash"],
    });
    return;
  } catch (err) {
    console.error("[nopm][telegram] audited revoke failed; revoking with a fallback audit row", id, err instanceof Error ? err.message : "unknown");
  }
  try {
    await db();
  } catch (err) {
    console.error("[nopm][telegram] failed to revoke action token", id, err instanceof Error ? err.message : "unknown");
    return;
  }
  try {
    await writeAudit({
      workspaceId: connector.workspace_id,
      actor: chatActor(connector, profile),
      action: "telegram.token.revoke",
      targetType: "telegram_action",
      targetId: id,
      before: null,
      after: { token_id: id, connector_id: connector.id, fallback: true },
    });
  } catch (err) {
    console.error("[nopm][telegram] fallback revoke audit row failed", id, err instanceof Error ? err.message : "unknown");
  }
}

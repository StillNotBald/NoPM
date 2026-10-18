import type { Actor } from "@/lib/auth/guard";
import { buildAuditArg } from "@/lib/audit/audited-write";
import type { AuditInput } from "@/lib/audit/row";

/**
 * TypeScript mirror of the SQL helper nopm_audit_insert (migration 0107, wave 5 Pre-0).
 *
 * Every dedicated RPC of wave 5 writes its audit row by calling the SQL helper inside its own
 * transaction. The RPC wrappers pass it the SAME audit object the atomic wrapper passes to
 * nopm_mutate_audited (buildAuditArg), so a row looks identical whichever path wrote it.
 * `sql-audit-insert.test.ts` pins this file to the migration text.
 */

/** The SQL function's name. */
export const AUDIT_INSERT_FN = "nopm_audit_insert";

/** Parameter names of nopm_audit_insert, in declaration order. The parity test compares them with the migration. */
export const AUDIT_INSERT_PARAMS = ["p_workspace_id", "p_audit", "p_target_id", "p_before", "p_after"] as const;

/**
 * Same rule as the SQL helper: lower-case verb.noun, optional further segments
 * ("task.update", "task.update.blocked"). Every entry of action-glossary.ts matches.
 */
export const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** The channels the SQL helper accepts (same set as migration 0103 and audit/channel.ts). */
export const AUDIT_INSERT_CHANNELS = ["ui", "api", "cli", "mcp", "assistant", "lark", "github"] as const;

/** The exact argument object of nopm_audit_insert. */
export type AuditInsertArgs = {
  p_workspace_id: string;
  p_audit: Record<string, unknown>;
  p_target_id: string | null;
  p_before: unknown;
  p_after: unknown;
};

/** Context an RPC caller may add on top of the actor (the overrides buildAuditArg accepts). */
export type RpcAuditOverrides = Parameters<typeof buildAuditArg>[4];

/**
 * The `p_audit` object for an RPC that writes its own audit row: a thin wrapper over buildAuditArg, so
 * it carries the actor, channel, request id, principal and connector provenance exactly as audited-write does.
 * A system actor (systemActor() in audit/write.ts) is passed like any other actor.
 */
export function buildRpcAudit(
  actor: Actor,
  action: string,
  targetType: string,
  overrides: RpcAuditOverrides = {},
  workspaceId: string = actor.workspaceId,
): Record<string, unknown> {
  return buildAuditArg(actor, workspaceId, action, targetType, overrides);
}

/**
 * The full argument object of nopm_audit_insert from the same input type writeAudit takes.
 * Throws on an action or channel the SQL helper would reject, so the mistake shows up in a unit test
 * instead of as a database error.
 */
export function buildAuditInsertArgs(input: AuditInput): AuditInsertArgs {
  if (!AUDIT_ACTION_PATTERN.test(input.action)) {
    throw new Error(`Invalid audit action: ${input.action}`);
  }
  const channel = input.actor.channel;
  if (channel !== undefined && channel !== null && !(AUDIT_INSERT_CHANNELS as readonly string[]).includes(channel)) {
    throw new Error(`Invalid audit channel: ${channel}`);
  }
  return {
    p_workspace_id: input.workspaceId,
    p_audit: buildRpcAudit(input.actor, input.action, input.targetType, {}, input.workspaceId),
    p_target_id: input.targetId ?? null,
    p_before: input.before ?? null,
    p_after: input.after ?? null,
  };
}

/** The slice of a Supabase client this module needs, so a test can pass a stub. */
export type RpcClient = {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
};

/**
 * Write ONE audit row through the SQL helper from TypeScript. For the rare caller that must add an
 * audit row inside an RPC it controls; a normal write goes through audited-write.ts or its own RPC.
 * Fail-closed like writeAudit: throws when the row could not be written. Returns the new row's id.
 */
export async function callAuditInsert(client: RpcClient, args: AuditInsertArgs): Promise<string> {
  const { data, error } = await client.rpc(AUDIT_INSERT_FN, args);
  if (error) throw new Error(`Fail-closed audit write failed: ${error.message ?? "unknown error"}`);
  if (typeof data !== "string") throw new Error("Fail-closed audit write failed: no audit row id returned");
  return data;
}

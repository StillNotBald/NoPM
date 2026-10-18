import { createAdminClient } from "@/lib/supabase/admin";
import type { Actor } from "@/lib/auth/guard";
import { auditPrincipalId, buildAuditRow, type AuditInput } from "@/lib/audit/row";

export { auditPrincipalId, buildAuditRow };
export type { AuditInput };

/**
 * Fixed id of the system actor (A3-10). Cron, digest, auto-close and clash
 * auto-resolve have no human and no api_tokens row; they are recorded with this
 * nil uuid and a `system:<label>` label so the Trust Center can filter them.
 * (audit_log.actor_type is an enum of 'user'|'token'; widening it needs a
 * separate migration, so system actors use actor_type 'token' + this id.)
 */
export const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

export function systemActor(
  workspaceId: string,
  label: string,
  extra: Partial<Pick<Actor, "channel" | "requestId" | "viaConnectorId">> = {},
): Actor {
  return {
    type: "token",
    id: SYSTEM_ACTOR_ID,
    label: `system:${label}`,
    workspaceId,
    principalId: null,
    ...extra,
  };
}

/**
 * R-12: the system actor is identified by its fixed id (the nil uuid) AND
 * actor_type 'token'. The "system:" label is only a secondary hint on top of
 * that: a token an admin merely NAMES "system:cron" (any other id) is not a
 * system actor.
 */
export function isSystemActor(actor: { id: string; type?: string | null; label?: string | null }): boolean {
  if (actor.id !== SYSTEM_ACTOR_ID) return false;
  if (actor.type != null && actor.type !== "token") return false;
  return actor.label == null || actor.label.startsWith("system:");
}

/**
 * Fail-closed audit write: every mutation MUST produce exactly one audit row.
 * Throws if the row can't be written, so the caller can abort the mutation
 * (no silent writes). Uses the service-role client; the audit_log table is
 * append-only (UPDATE/DELETE blocked at the DB level).
 */
export async function writeAudit(input: AuditInput): Promise<void> {
  const admin = createAdminClient();
  const row = buildAuditRow(input);
  const principalId = auditPrincipalId(input.actor);
  let { error } = await admin
    .from("audit_log")
    .insert(principalId ? { ...row, principal_id: principalId } : row);
  // Deploy-order safety: if the app is live before migration 0071 the column
  // does not exist yet; retry once without it rather than failing every write.
  if (error && principalId && /principal_id/.test(error.message)) {
    ({ error } = await admin.from("audit_log").insert(row));
  }
  if (error) {
    throw new Error(`Fail-closed audit write failed: ${error.message}`);
  }
}

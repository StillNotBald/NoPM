import { createAdminClient } from "@/lib/supabase/admin";
import type { Actor } from "@/lib/auth/guard";

export type AuditInput = {
  workspaceId: string;
  actor: Actor;
  action: string; // verb.noun, e.g. "task.create"
  targetType: string;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
};

/**
 * Connector provenance (migration 0046): which integration relayed the action,
 * the platform's event id and the platform user reference. They are written
 * ONLY when the Actor carries them, so first-party writes keep the exact row
 * shape they always had (and keep working on a database that has not applied
 * 0046 yet); a connector-originated action is non-repudiable without stuffing
 * the `after` JSON.
 */
function connectorProvenance(actor: Actor): Record<string, string> {
  return {
    ...(actor.viaConnectorId ? { via_connector_id: actor.viaConnectorId } : {}),
    ...(actor.externalEventId ? { external_event_id: actor.externalEventId } : {}),
    ...(actor.externalActorRef ? { external_actor_ref: actor.externalActorRef } : {}),
  };
}

/**
 * The HUMAN principal behind an actor (A3-12): the session user, the PAT's
 * creator, or the verified linked profile of a connector action. Falls back to
 * the actor's own id for a session user. Null for system actors and legacy
 * tokens with no recorded creator. Stored in audit_log.principal_id (0071).
 */
export function auditPrincipalId(actor: Actor): string | null {
  if (actor.principalId) return actor.principalId;
  if (actor.principalId === undefined && actor.type === "user") return actor.id;
  return null;
}

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
  const row: Record<string, unknown> = {
    workspace_id: input.workspaceId,
    actor_type: input.actor.type,
    actor_id: input.actor.id,
    actor_label: input.actor.label,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId ?? null,
    before: (input.before as object) ?? null,
    after: (input.after as object) ?? null,
    channel: input.actor.channel ?? null,
    request_id: input.actor.requestId ?? null,
    ...connectorProvenance(input.actor),
  };
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

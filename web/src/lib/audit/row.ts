import type { Actor } from "@/lib/auth/guard";

/**
 * Pure audit-row helpers, split out of write.ts so the atomic wrapper (audited-write.ts) does not
 * depend on the module that tests commonly replace with a mock. write.ts re-exports them.
 */

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
 * The audit_log row for an input, WITHOUT the optional principal_id column.
 * Shared by writeAudit and the atomic wrapper (audited-write.ts) so both
 * produce the same payload shape and the same glossary actions.
 */
export function buildAuditRow(input: AuditInput): Record<string, unknown> {
  return {
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
}

import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import type { Actor } from "@/lib/auth/guard";
import { APPROVER_ROLE_MESSAGE } from "@/lib/auth/approver";
import { NO_PRINCIPAL_MESSAGE, selfApprovalError } from "@/lib/governance/decide";

/** The provenance arguments every audit-writing RPC of migrations 0062 / 0063 takes. */
export function auditRpcArgs(actor: Actor) {
  return {
    p_actor_type: actor.type,
    p_actor_id: actor.id,
    p_actor_label: actor.label,
    p_channel: actor.channel ?? null,
    p_correlation_id: actor.requestId ?? null,
    p_via_connector_id: actor.viaConnectorId ?? null,
    p_external_event_id: actor.externalEventId ?? null,
    p_external_actor_ref: actor.externalActorRef ?? null,
  };
}

export const PROJECT_NOT_LOCKED_MESSAGE =
  "Rebaseline cannot be applied: its project is no longer locked. Lock the project and propose a new rebaseline.";
export const PENDING_REBASELINE_EXISTS_MESSAGE = "This project already has a rebaseline waiting for sign-off";

type RpcError = { message?: string | null; code?: string | null };

/**
 * Translate the errcodes the rebaseline / lock RPCs raise (migrations 0061-0063)
 * into the API's typed errors. Anything unrecognised is rethrown as a plain Error
 * (a 500) so a real fault is never disguised as a rule violation.
 */
export function throwRebaselineRpcError(
  error: RpcError,
  fallback: string,
  alreadyDecided: RuleError = new RuleError(
    "This rebaseline was decided while your request was being processed.",
    "rebaseline_not_pending",
  ),
): never {
  const m = `${error.message ?? ""} ${error.code ?? ""}`;
  if (m.includes("NOT_FOUND") || error.code === "P0002") throw new NotFoundError("Not found");
  if (m.includes("ROLE_NOT_PERMITTED") || error.code === "P0018")
    throw new ScopeError(APPROVER_ROLE_MESSAGE, "role_not_permitted");
  if (m.includes("NO_PRINCIPAL") || error.code === "P0006") throw new ScopeError(NO_PRINCIPAL_MESSAGE, "no_principal");
  if (m.includes("SELF_APPROVAL") || m.includes("SELF_SIGNOFF") || error.code === "P0003") throw selfApprovalError();
  if (m.includes("PROJECT_NOT_LOCKED") || error.code === "P0019")
    throw new RuleError(PROJECT_NOT_LOCKED_MESSAGE, "project_not_locked");
  if (m.includes("ALREADY_DECIDED") || error.code === "P0001") throw alreadyDecided;
  throw new Error(error.message || fallback);
}

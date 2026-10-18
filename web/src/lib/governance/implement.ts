import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { NO_PRINCIPAL_MESSAGE } from "@/lib/governance/decide";

/**
 * M2 (audit gaps, assumption A2): the "approved, then live" proof.
 * Marking an APPROVED change request implemented is ONE database transaction
 * (nopm_implement_change_request, migration 0092): the status moves to
 * 'implemented', implemented_at / by / principal / note are stamped, and the
 * audit row change_request.implement is written before the commit. The CHECK
 * cr_implemented_after_decision makes "implemented_at >= decided_at" a database fact.
 *
 * Who: the requester's person, or a manager or admin. A principal (the human
 * behind the actor) is required; a token with no recorded owner is refused.
 */
export const IMPLEMENT_NOT_ALLOWED_MESSAGE =
  "Only the requester, or a manager or admin, can mark a change request implemented.";
export const IMPLEMENT_STATE_MESSAGE = "Only an approved change request can be marked implemented.";
export const ALREADY_IMPLEMENTED_MESSAGE = "This change request is already marked implemented.";

type RpcError = { message?: string | null; code?: string | null };

/** Translate the errcodes nopm_implement_change_request raises into typed API errors; anything else is a 500. */
export function throwImplementRpcError(error: RpcError): never {
  const m = `${error.message ?? ""} ${error.code ?? ""}`;
  if (m.includes("NOT_FOUND") || error.code === "P0002") throw new NotFoundError("Change request not found");
  if (m.includes("NO_PRINCIPAL") || error.code === "P0006") throw new ScopeError(NO_PRINCIPAL_MESSAGE, "no_principal");
  if (m.includes("NOT_ALLOWED") || m.includes("NOT_REQUESTER") || error.code === "P0023") {
    throw new ScopeError(IMPLEMENT_NOT_ALLOWED_MESSAGE, "not_requester");
  }
  if (m.includes("ALREADY_IMPLEMENTED") || error.code === "P0028") {
    throw new RuleError(ALREADY_IMPLEMENTED_MESSAGE, "already_implemented");
  }
  if (m.includes("INVALID_TRANSITION") || error.code === "P0024") {
    throw new RuleError(IMPLEMENT_STATE_MESSAGE, "invalid_transition");
  }
  throw new Error(error.message || "Failed to mark the change request implemented");
}

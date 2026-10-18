import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { APPROVER_ROLE_MESSAGE } from "@/lib/auth/approver";
import { NO_PRINCIPAL_MESSAGE } from "@/lib/governance/decide";

/**
 * The two audited status moves on a change request that are not a decision
 * (migration 0076, nopm_transition_change_request):
 *   start_review  raised   -> under_review   a manager or admin (Q-GOV-3)
 *   reopen        deferred -> under_review   the requester, or a manager or admin
 *                                            (owner decision 24: "defer" is parked)
 * The change and its audit row are one database transaction (Q-GOV-23).
 */
export type ChangeTransition = "start_review" | "reopen";

export const START_REVIEW_ROLE_MESSAGE = "Only a manager or admin can move a request to under review.";
export const REOPEN_NOT_ALLOWED_MESSAGE = "Only the requester, or a manager or admin, can reopen a deferred request.";
export const START_REVIEW_STATE_MESSAGE = "Only a raised request can be moved to under review.";
export const REOPEN_STATE_MESSAGE = "Only a deferred request can be reopened.";

type RpcError = { message?: string | null; code?: string | null };

/** Translate the errcodes nopm_transition_change_request raises into typed API errors; anything else is a 500. */
export function throwTransitionRpcError(error: RpcError, action: ChangeTransition): never {
  const m = `${error.message ?? ""} ${error.code ?? ""}`;
  if (m.includes("NOT_FOUND") || error.code === "P0002") throw new NotFoundError("Change request not found");
  if (m.includes("NO_PRINCIPAL") || error.code === "P0006") throw new ScopeError(NO_PRINCIPAL_MESSAGE, "no_principal");
  if (m.includes("ROLE_NOT_PERMITTED") || error.code === "P0018") {
    throw new ScopeError(action === "start_review" ? START_REVIEW_ROLE_MESSAGE : APPROVER_ROLE_MESSAGE, "role_not_permitted");
  }
  if (m.includes("NOT_REQUESTER") || error.code === "P0023") {
    throw new ScopeError(REOPEN_NOT_ALLOWED_MESSAGE, "not_requester");
  }
  if (m.includes("INVALID_TRANSITION") || error.code === "P0024") {
    throw new RuleError(action === "start_review" ? START_REVIEW_STATE_MESSAGE : REOPEN_STATE_MESSAGE, "invalid_transition");
  }
  throw new Error(error.message || "Failed to update the change request");
}

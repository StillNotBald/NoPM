import type { Actor } from "@/lib/auth/guard";
import type { ApprovalKind, ApprovalRef } from "@/lib/integrations/types";

/**
 * One governed decision path for every surface (UI, REST, CLI, MCP, Lark).
 *
 * STUB — implemented by W1 (governance). Keep these exported signatures; the
 * REST decision routes become thin wrappers over the per-kind functions and
 * the Integration Hub's inbound pipeline calls `decideApproval`.
 */

export type DecisionResult = {
  kind: ApprovalKind;
  id: string;
  /** The request's status after the decision (e.g. "committed", "rejected", "approved"). */
  status: string;
  /** Human-readable title of the decided request (for chat cards / toasts). */
  title: string;
  requesterPrincipalId: string | null;
};

/**
 * Approve or reject a governed request as `actor`. Throws the same ApiErrors
 * the REST routes throw (ScopeError on self-approval / missing principal /
 * missing scope, RuleError when already decided or locked, NotFoundError).
 * `note` is required (non-empty) for "reject".
 */
export async function decideApproval(
  actor: Actor,
  ref: ApprovalRef,
  action: "approve" | "reject",
  note?: string,
): Promise<DecisionResult> {
  void actor;
  void ref;
  void action;
  void note;
  throw new Error("decideApproval: not implemented yet (W1)");
}

import type { Actor } from "@/lib/auth/guard";
import { ScopeError } from "@/lib/api/errors";

export const APPROVER_ROLE_MESSAGE = "Only managers and admins can approve";

/**
 * Owner decision D-16 ("follow Lark rules", 2026-10-17): approving or deciding
 * is for admins and managers only, on EVERY channel. A session user is judged by
 * their own role; a token by the role of the HUMAN behind it (`principalRole`,
 * resolved from `api_tokens.created_by`), so a member cannot approve by minting
 * a token and a demoted creator's token stops approving at once. A token whose
 * creator is unknown has no role and is refused (fail-closed).
 *
 * Call this in every approve / reject / decide verb, next to the scope check.
 * The same rule is repeated in the database by the decision RPCs
 * (errcode P0018), and the chat connectors already refuse non-approvers
 * (lib/integrations/inbound.ts).
 */
export function requireApprover(actor: Actor): void {
  const role =
    actor.type === "user"
      ? actor.role
      : (actor as Actor & { principalRole?: string | null }).principalRole;
  if (role !== "admin" && role !== "manager") {
    throw new ScopeError(APPROVER_ROLE_MESSAGE, "role_not_permitted");
  }
}

import { ScopeError } from "@/lib/api/errors";
import type { Actor } from "@/lib/auth/guard";

/**
 * Who may lock and unlock a project (Q-GOV-10, common-pattern answer 2026-10-17).
 *
 *   Lock   - a signed-in manager or admin, or a token holding project:write
 *            (the scope check stays in the route; viewers are read-only there).
 *   Unlock - a signed-in manager or admin, in person. Unlock stays a single-person
 *            act (decision 7) but it reopens frozen dates and voids sign-offs, so
 *            an agent (any token) can never do it.
 */
export const LOCK_ROLE_MESSAGE = "Only a manager or admin can lock a project.";
export const UNLOCK_ROLE_MESSAGE = "Only a manager or admin can unlock a project, in person.";
export const UNLOCK_AGENT_MESSAGE = "Only a manager or admin can unlock a project, in person. Agents and API tokens cannot.";

function isManagerOrAdmin(role: string | null | undefined): boolean {
  return role === "admin" || role === "manager";
}

/** A person must be a manager or admin; a token passes (its scope was already checked). */
export function requireCanLock(actor: Actor): void {
  if (actor.type === "user" && !isManagerOrAdmin(actor.role)) {
    throw new ScopeError(LOCK_ROLE_MESSAGE, "role_not_permitted");
  }
}

/** Only a manager or admin in person; every token is refused (403 `agents_cannot_unlock`). */
export function requireCanUnlock(actor: Actor): void {
  if (actor.type !== "user") throw new ScopeError(UNLOCK_AGENT_MESSAGE, "agents_cannot_unlock");
  if (!isManagerOrAdmin(actor.role)) throw new ScopeError(UNLOCK_ROLE_MESSAGE, "role_not_permitted");
}

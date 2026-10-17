import type { Actor } from "@/lib/auth/guard";
import { ScopeError } from "@/lib/api/errors";

/**
 * Owner decision D-17: a member may log, edit and delete only their OWN hours;
 * admins and managers may do it for anyone. For a token the HUMAN behind it
 * counts (principalRole / principalId = the token's creator). A resource row
 * with no linked profile can be written by an admin or manager only.
 */
export function assertMayActForMemberHours(
  actor: Actor,
  member: { profile_id?: string | null },
): void {
  const role =
    actor.type === "user" ? actor.role : actor.principalRole;
  if (role === "admin" || role === "manager") return;
  if (member.profile_id && actor.principalId && member.profile_id === actor.principalId) return;
  throw new ScopeError("You can only log your own hours", "not_your_hours");
}

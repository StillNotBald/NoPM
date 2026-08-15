import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import type { Actor } from "@/lib/auth/guard";

/**
 * Link-invite guard logic (L-47/L-48, D5/D6, f2b-specs.md). Extracted as
 * pure functions — same rationale as lib/governance/timesheet-decision.ts —
 * so the role-escalation cap and the accept-flow error mapping are
 * unit-testable without a live database or a real auth session.
 */

export const MEMBER_ROLES = ["viewer", "member", "manager", "admin"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Lowest → highest privilege. Used ONLY for the invite role-escalation cap. */
const ROLE_RANK: Record<MemberRole, number> = {
  viewer: 0,
  member: 1,
  manager: 2,
  admin: 3,
};

function isMemberRole(role: string): role is MemberRole {
  return (MEMBER_ROLES as readonly string[]).includes(role);
}

/**
 * D5: only a USER session (never a token/agent actor) with role admin or
 * manager may create/list/revoke invites — the same requireTokenAdmin
 * precedent api/tokens/route.ts established for token management.
 */
export function assertCanManageInvites(actor: Actor): void {
  if (actor.type !== "user" || !["admin", "manager"].includes(actor.role ?? "")) {
    throw new ScopeError("Invite management requires an admin/manager session");
  }
}

/**
 * D5 role-escalation cap: invite.role must be <= the creator's own role
 * rank (viewer < member < manager < admin) — so a manager can mint a
 * manager/member/viewer invite but never an admin invite; only an admin
 * can mint an admin invite. This is the exact LOCKED wording (D5,
 * f2b-specs.md HOUSE RULES/LOCKED DECISIONS section) — verbatim rank
 * comparison, not a hand-listed allow-map, so it can never drift out of
 * sync with MEMBER_ROLES/ROLE_RANK above.
 */
export function assertRoleWithinCap(creatorRole: string, inviteRole: string): void {
  const creatorRank = isMemberRole(creatorRole) ? ROLE_RANK[creatorRole] : -1;
  const inviteRank = isMemberRole(inviteRole) ? ROLE_RANK[inviteRole] : Infinity;
  if (inviteRank > creatorRank) {
    throw new RuleError(
      `Cannot invite role '${inviteRole}' — it outranks your own role`,
      "role_escalation",
    );
  }
}

export type InviteRow = {
  revoked: boolean;
  accepted_at: string | null;
  expires_at: string;
};

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

/** Status is DERIVED (never a stored column) — see migration 0039's header comment. */
export function deriveInviteStatus(invite: InviteRow, now: Date = new Date()): InviteStatus {
  if (invite.revoked) return "revoked";
  if (invite.accepted_at) return "accepted";
  if (new Date(invite.expires_at) <= now) return "expired";
  return "pending";
}

/** Only a pending invite may be revoked (422 otherwise). */
export function assertRevocable(invite: InviteRow, now: Date = new Date()): void {
  const status = deriveInviteStatus(invite, now);
  if (status !== "pending") {
    throw new RuleError(`Invite is not pending (status: ${status})`, "already_decided");
  }
}

/**
 * Pre-validation on the invite lookup, BEFORE createUser is attempted — the
 * accept route's "clean error" pass (T7, f2b-specs.md). The RPC re-validates
 * under its own FOR UPDATE lock regardless (TOCTOU-safe, mirrors the
 * deletion-commit precedent), so this is a fast, cheap-to-reach 404/422 for
 * the common cases, not the sole source of truth.
 */
export function assertInviteAcceptable(invite: InviteRow, now: Date = new Date()): void {
  const status = deriveInviteStatus(invite, now);
  if (status === "accepted" || status === "revoked") {
    throw new RuleError("This invite has already been used", "already_used");
  }
  if (status === "expired") {
    throw new RuleError("This invite has expired", "expired");
  }
}

/**
 * Maps nopm_accept_invite's typed P-code exceptions (migration 0039) to the
 * API's error contract — same shape as the deletion-commit RPC mapping in
 * api/deletion-requests/[id]/approve/route.ts.
 */
export function mapAcceptRpcError(error: { message?: string; code?: string } | null | undefined): Error {
  const m = `${error?.message ?? ""} ${error?.code ?? ""}`;
  if (m.includes("NOT_FOUND") || error?.code === "P0002") return new NotFoundError("Invite not found");
  if (m.includes("ALREADY_USED") || error?.code === "P0001")
    return new RuleError("This invite has already been used", "already_used");
  if (m.includes("EXPIRED") || error?.code === "P0004") return new RuleError("This invite has expired", "expired");
  return new Error(error?.message || "Failed to accept invite");
}

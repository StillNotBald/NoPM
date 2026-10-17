import { RuleError, ScopeError } from "@/lib/api/errors";
import type { Actor } from "@/lib/auth/guard";

/**
 * Link-invite guard logic (L-47/L-48, D5/D6, f2b-specs.md). Extracted as
 * pure functions
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
 * T3 (F2c-mini) anti-enumeration: not-found, expired, already-accepted, and
 * revoked ALL collapse into this ONE 422 message on the accept API — a
 * caller scripting against POST /api/invites/accept can never distinguish
 * "no such token" from "already used" from "expired" via status code or
 * message (previously: 404 for not-found, and two distinct 422 messages —
 * each a usable oracle).
 *
 * Deliberate ASYMMETRY, not an oversight: the public /invite/[token] PAGE
 * (app/invite/[token]/page.tsx) keeps its own distinct friendly per-status
 * copy ("expired" vs "already used" vs "revoked" vs "not found"). That page
 * reads the invites table directly, server-side, for the one visitor who
 * already holds the exact link — it is not a scriptable enumeration surface
 * the way the JSON API is. Only the API collapses.
 *
 * email_exists (invite-accept.ts's isEmailExistsError path) stays a
 * DISTINCT message on purpose too — the caller reaching that branch already
 * holds a valid, pending invite token for that email (assertInviteAcceptable
 * passed), so there is no new information disclosed by naming the conflict.
 */
export const INVITE_ACCEPT_ERROR_MESSAGE = "This invite link is not valid or has expired.";

/**
 * Also called directly by the accept route for its "invite not found"
 * branch (before an InviteRow even exists to hand to assertInviteAcceptable)
 * so a missing token throws the exact same shape as an expired/used one.
 */
export function throwInviteNotAcceptable(): never {
  throw new RuleError(INVITE_ACCEPT_ERROR_MESSAGE, "invalid_or_expired");
}

/**
 * Pre-validation on the invite lookup, BEFORE createUser is attempted — the
 * accept route's "clean error" pass (T7, f2b-specs.md). The RPC re-validates
 * under its own FOR UPDATE lock regardless (TOCTOU-safe, mirrors the
 * deletion-commit precedent), so this is a fast, cheap-to-reach 422 for the
 * common cases, not the sole source of truth. See INVITE_ACCEPT_ERROR_MESSAGE
 * above for why every non-pending status maps to the same message.
 */
export function assertInviteAcceptable(invite: InviteRow, now: Date = new Date()): void {
  const status = deriveInviteStatus(invite, now);
  if (status !== "pending") {
    throwInviteNotAcceptable();
  }
}

/**
 * Maps nopm_accept_invite's typed P-code exceptions (migration 0039) to the
 * API's error contract — same shape as the deletion-commit RPC mapping in
 * api/deletion-requests/[id]/approve/route.ts. Collapsed to the single
 * anti-enumeration message (see INVITE_ACCEPT_ERROR_MESSAGE above) rather
 * than a distinct message/status per P-code.
 */
export function mapAcceptRpcError(error: { message?: string; code?: string } | null | undefined): Error {
  const m = `${error?.message ?? ""} ${error?.code ?? ""}`;
  const isNotFound = m.includes("NOT_FOUND") || error?.code === "P0002";
  const isAlreadyUsed = m.includes("ALREADY_USED") || error?.code === "P0001";
  const isExpired = m.includes("EXPIRED") || error?.code === "P0004";
  if (isNotFound || isAlreadyUsed || isExpired) {
    return new RuleError(INVITE_ACCEPT_ERROR_MESSAGE, "invalid_or_expired");
  }
  return new Error(error?.message || "Failed to accept invite");
}

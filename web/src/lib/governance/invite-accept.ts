import { buildRpcAudit } from "@/lib/audit/sql-audit-insert";
import type { Actor } from "@/lib/auth/guard";
import { RuleError } from "@/lib/api/errors";
import { mapAcceptRpcError } from "@/lib/governance/invite-guard";

/**
 * D6 (f2b-specs.md): auth-user-FIRST, then the atomic profiles+resource_
 * members+invite-mark+2-audit-rows RPC. Extracted as a pure(ish) orchestration
 * function — dependency-injected on a minimal structural admin-client shape —
 * so the FAILURE-INJECTION criterion (L-48: "half-created identity impossible
 * or fail-closed") is unit-testable without a live Supabase project: a test
 * can hand this function a fake client whose `.rpc()` rejects and assert
 * `.auth.admin.deleteUser` was called with the just-created user id, and that
 * the mapped error still propagates (fail-closed — the caller sees a real
 * error, not a swallowed one).
 */

export type InviteAcceptAdminClient = {
  auth: {
    admin: {
      createUser: (input: {
        email: string;
        password: string;
        email_confirm: boolean;
        user_metadata?: Record<string, unknown>;
      }) => Promise<{
        data: { user: { id: string } | null } | null;
        error: { message?: string; code?: string } | null;
      }>;
      deleteUser: (userId: string) => Promise<{ error: { message?: string } | null }>;
      /** R-16: read created_at / user_metadata of a stranded user before adopting it. */
      getUserById?: (userId: string) => Promise<{
        data: { user: { id: string; created_at?: string; user_metadata?: Record<string, unknown> | null } | null } | null;
        error: { message?: string } | null;
      }>;
      updateUserById: (
        userId: string,
        attrs: { password: string; email_confirm: boolean },
      ) => Promise<{ error: { message?: string } | null }>;
    };
  };
  // PromiseLike (not Promise): supabase-js's real .rpc() returns a
  // PostgrestFilterBuilder — thenable, but not a full Promise (no
  // catch/finally) — so the structural type here only demands what this
  // module actually does with it: `await`.
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
};

export type AcceptInviteInput = {
  tokenHash: string;
  email: string; // ALWAYS the invite's own email — never client-supplied (D6)
  password: string;
  displayName: string;
  /** R-84 provenance, threaded through to nopm_accept_invite's p_channel /
   *  p_correlation_id (migration 20260906000044). This route runs with
   *  { auth: false } (anonymous acceptor, no session/token Actor to read
   *  these off) — the caller resolves them directly via
   *  resolveClientMeta(request.headers, 'user'). */
  channel?: string | null;
  requestId?: string | null;
  /** The invite being accepted (invites.id). Stamped on the auth user it creates so a retry can tell its own half-made identity from anyone else's (R-16). */
  inviteId?: string | null;
};

/** R-16: a profile-less auth user is only adopted by a retry when it is this fresh. */
export const STRANDED_USER_MAX_AGE_MS = 60 * 60 * 1000;

export type AcceptInviteResult = {
  profile_id: string;
  member_id: string;
  workspace_id: string;
};

/** True for the Supabase GoTrue "email already registered" family of errors. */
function isEmailExistsError(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "email_exists") return true;
  return /already registered|already exists|duplicate/i.test(error.message ?? "");
}

/**
 * D-ACC-3: an earlier accept attempt may have created the auth user and then
 * failed (the RPC errored, and the best-effort clean-up did not run). The
 * invite is still pending, so the retry must finish the job instead of dying on
 * "email already exists". Returns the id of an auth user for this email that
 * owns NO profile (a stranded half-identity), else null. A user WITH a profile
 * is a real account and is never touched. The lookup is the service-role-only
 * nopm_auth_user_for_invite function (auth.users is not reachable via PostgREST).
 */
async function findStrandedAuthUser(
  db: InviteAcceptAdminClient,
  email: string,
  inviteId: string | null | undefined,
): Promise<string | null> {
  try {
    const { data, error } = await db.rpc("nopm_auth_user_for_invite", { p_email: email });
    if (error || !Array.isArray(data) || data.length === 0) return null;
    const row = data[0] as { user_id?: string; has_profile?: boolean };
    if (!row.user_id || row.has_profile !== false) return null;

    // R-16: do not adopt just ANY profile-less sign-in for this address (e.g. one
    // whose profile an operator removed by hand, or one belonging to another app
    // on a shared auth project). Only a recent one, and - when it carries the
    // invite that created it - only this invite's. If its age cannot be read, do
    // not adopt it.
    if (!db.auth.admin.getUserById) return null;
    const { data: got, error: getError } = await db.auth.admin.getUserById(row.user_id);
    const user = got?.user;
    if (getError || !user?.created_at) return null;
    const age = Date.now() - Date.parse(user.created_at);
    if (!Number.isFinite(age) || age < -60_000 || age > STRANDED_USER_MAX_AGE_MS) return null;
    const stamped = user.user_metadata?.invite_id;
    if (typeof stamped === "string" && inviteId && stamped !== inviteId) return null;
    return row.user_id;
  } catch {
    return null; // lookup unavailable: fall back to the plain "already exists" answer
  }
}

/**
 * Orchestrates: admin.auth.admin.createUser (email_confirm: true) FIRST,
 * then the nopm_accept_invite RPC. If the RPC fails AFTER the auth user was
 * created, best-effort admin.auth.admin.deleteUser cleans it up (never lets
 * the cleanup attempt itself swallow the real error — the mapped RPC error
 * always propagates, cleanup or not).
 */
export async function performInviteAccept(
  db: InviteAcceptAdminClient,
  input: AcceptInviteInput,
): Promise<AcceptInviteResult> {
  const { data: createData, error: createError } = await db.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    ...(input.inviteId ? { user_metadata: { invite_id: input.inviteId } } : {}),
  });

  // The auth user this attempt created, or reused (see findStrandedAuthUser).
  let userId: string | null = createData?.user?.id ?? null;
  let reused = false;

  if (createError || !createData?.user) {
    if (isEmailExistsError(createError)) {
      const stranded = await findStrandedAuthUser(db, input.email, input.inviteId);
      if (!stranded) {
        throw new RuleError("An account with this email already exists", "email_exists");
      }
      // The invite holder is the only person who can reach this point (the route
      // validated a pending invite for exactly this e-mail), so the retry sets
      // the password they just chose on the half-created identity.
      const { error: updateError } = await db.auth.admin.updateUserById(stranded, {
        password: input.password,
        email_confirm: true,
      });
      if (updateError) {
        throw new RuleError(updateError.message || "Could not create your account", "account_creation_failed");
      }
      userId = stranded;
      reused = true;
    } else {
    // Any other createUser failure (weak password rejected by Supabase's own
    // policy, transient provider error, ...) is still a clean client-facing
    // 422 on this public accept endpoint — never a raw 500 that could leak
    // provider internals.
    throw new RuleError(createError?.message || "Could not create your account", "account_creation_failed");
    }
  }

  if (!userId) throw new RuleError("Could not create your account", "account_creation_failed");

  const { data: rpcData, error: rpcError } = await db.rpc("nopm_accept_invite", {
    p_token_hash: input.tokenHash,
    p_auth_user_id: userId,
    p_email: input.email,
    p_display_name: input.displayName,
    p_channel: input.channel ?? null,
    p_correlation_id: input.requestId ?? null,
  });

  if (rpcError) {
    // Best-effort cleanup — a half-created identity (auth user with no
    // profile) should be avoided when possible. If the cleanup call itself
    // fails, the fail-closed backstop still holds: verifySession (guard.ts)
    // throws "No workspace profile for this user" (401) for any auth user
    // without a matching profiles row, so a stranded user can never sign in
    // successfully even if this cleanup didn't run.
    try {
      // A reused identity is left in place: the retry path above picks it up again.
      if (!reused) await db.auth.admin.deleteUser(userId);
    } catch {
      // fail-soft cleanup — see comment above; the mapped RPC error below
      // must still propagate regardless of whether cleanup succeeded.
    }
    throw mapAcceptRpcError(rpcError);
  }

  return rpcData as AcceptInviteResult;
}

type SweepClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
};

/**
 * R3-2: when any invite for an email is accepted, every OTHER open invite for
 * that email in the workspace is revoked (one audit row each), so a stale link
 * can never be used later against the account that was just created/restored.
 * Returns the revoked invite ids.
 *
 * One database function (migration 0109, R-164c): the bulk revoke and every
 * invite.revoked audit row are one transaction, so an invite can never be
 * revoked without its row. The function keeps the ilike escape (backslash, %
 * and _ in the e-mail are literals), accepted_at is null and revoked = false.
 */
export async function revokeOtherInvitesForEmail(
  db: SweepClient,
  args: {
    workspaceId: string;
    email: string;
    keepInviteId: string;
    actorId: string;
    actorLabel: string;
    channel?: string | null;
    requestId?: string | null;
  },
): Promise<string[]> {
  const actor: Actor = {
    type: "user",
    id: args.actorId,
    label: args.actorLabel,
    workspaceId: args.workspaceId,
    role: undefined,
    principalId: args.actorId,
    principalRole: undefined,
    channel: (args.channel ?? undefined) as Actor["channel"],
    requestId: args.requestId ?? undefined,
  };
  const { data, error } = await db.rpc("nopm_revoke_other_invites", {
    p_workspace_id: args.workspaceId,
    p_email: args.email,
    p_keep_invite_id: args.keepInviteId,
    p_audit: buildRpcAudit(actor, "invite.revoked", "invite"),
  });
  if (error) throw error;
  return Array.isArray(data) ? (data as string[]) : [];
}

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
      }) => Promise<{
        data: { user: { id: string } | null } | null;
        error: { message?: string; code?: string } | null;
      }>;
      deleteUser: (userId: string) => Promise<{ error: { message?: string } | null }>;
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
};

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
  });

  if (createError || !createData?.user) {
    if (isEmailExistsError(createError)) {
      throw new RuleError("An account with this email already exists", "email_exists");
    }
    // Any other createUser failure (weak password rejected by Supabase's own
    // policy, transient provider error, ...) is still a clean client-facing
    // 422 on this public accept endpoint — never a raw 500 that could leak
    // provider internals.
    throw new RuleError(createError?.message || "Could not create your account", "account_creation_failed");
  }

  const userId = createData.user.id;

  const { data: rpcData, error: rpcError } = await db.rpc("nopm_accept_invite", {
    p_token_hash: input.tokenHash,
    p_auth_user_id: userId,
    p_email: input.email,
    p_display_name: input.displayName,
  });

  if (rpcError) {
    // Best-effort cleanup — a half-created identity (auth user with no
    // profile) should be avoided when possible. If the cleanup call itself
    // fails, the fail-closed backstop still holds: verifySession (guard.ts)
    // throws "No workspace profile for this user" (401) for any auth user
    // without a matching profiles row, so a stranded user can never sign in
    // successfully even if this cleanup didn't run.
    try {
      await db.auth.admin.deleteUser(userId);
    } catch {
      // fail-soft cleanup — see comment above; the mapped RPC error below
      // must still propagate regardless of whether cleanup succeeded.
    }
    throw mapAcceptRpcError(rpcError);
  }

  return rpcData as AcceptInviteResult;
}

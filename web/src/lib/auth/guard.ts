import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { hashToken, hasScope } from "@/lib/auth/tokens";
import { AuthError, ScopeError } from "@/lib/api/errors";
import { resolveClientMeta, type AuditChannel } from "@/lib/audit/channel";
import { MFA_COOKIE_NAME, verifyMfaCookie, getMfaEnrollmentStatus } from "@/lib/auth/mfa";

export type { AuditChannel };

/**
 * The resolved caller. Either a human (Supabase session) or an agent
 * (scoped Bearer PAT). Every endpoint scopes its queries by `workspaceId`
 * — RLS protects session users; for token callers (admin client bypasses
 * RLS) the workspace filter is mandatory and enforced in each handler.
 */
export type Actor = {
  type: "user" | "token";
  id: string;
  label: string;
  workspaceId: string;
  role?: string; // member_role for users
  scopes?: string[]; // for tokens
  tokenId?: string;
  /** Declared client (caller-asserted via X-NoPM-Client; provenance only —
   *  never an authorization input). See @/lib/audit/channel. */
  channel?: AuditChannel;
  /** Per-request correlation id (X-Request-Id, echoed on the response). */
  requestId?: string;
};

/**
 * Routes that must keep working for a session actor who is MFA-enrolled but
 * has not yet passed the challenge — the challenge submission itself, and
 * the status poll the login page uses to decide whether to show the code
 * step. Every other session-authenticated route requires a valid
 * `nopm_mfa` cookie once the user has MFA enabled (R-91).
 */
const MFA_CHALLENGE_EXEMPT_PATHS = new Set<string>(["/api/auth/mfa", "/api/auth/mfa/challenge"]);

function isMfaChallengeExempt(request: Request): boolean {
  try {
    return MFA_CHALLENGE_EXEMPT_PATHS.has(new URL(request.url).pathname);
  } catch {
    return false;
  }
}

export async function requireAuth(request: Request): Promise<Actor> {
  const authz = request.headers.get("authorization");
  if (authz?.toLowerCase().startsWith("bearer ")) {
    const actor = await verifyBearer(authz.slice(7).trim());
    return { ...actor, ...resolveClientMeta(request.headers, "token") };
  }
  const actor = await verifySession();
  const full: Actor = { ...actor, ...resolveClientMeta(request.headers, "user") };

  if (!isMfaChallengeExempt(request)) {
    await assertMfaSatisfied(full.id);
  }

  return full;
}

/**
 * R-91 — a session actor who has enabled MFA must carry a valid `nopm_mfa`
 * cookie (issued by POST /api/auth/mfa/challenge after a correct TOTP or
 * backup code), bound to the account's *current* enrollment. Token (Bearer
 * PAT) actors never reach this function. Unenrolled users (the common case,
 * including the shared demo login, which is never MFA-enrolled)
 * short-circuit on the `enabled` check below without ever touching the
 * cookie. One `user_mfa` lookup (enabled + enrolled_at, for the enrollment
 * binding) — errors propagate uncaught (fail-closed: no actor is ever
 * resolved for this request).
 */
async function assertMfaSatisfied(uid: string): Promise<void> {
  const { enabled, enr } = await getMfaEnrollmentStatus(uid);
  if (!enabled || enr === null) return;

  const store = await cookies();
  const cookieValue = store.get(MFA_COOKIE_NAME)?.value;
  if (!verifyMfaCookie(cookieValue, uid, enr)) {
    throw new AuthError("MFA required", "mfa_required");
  }
}

async function verifyBearer(raw: string): Promise<Actor> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("api_tokens")
    .select("id, workspace_id, name, scopes, revoked, expires_at")
    .eq("token_hash", hashToken(raw))
    .maybeSingle();

  if (error || !data) throw new AuthError("Invalid API token");
  if (data.revoked) throw new AuthError("API token has been revoked");
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    throw new AuthError("API token has expired");
  }

  // fire-and-forget last_used_at
  void admin
    .from("api_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);

  return {
    type: "token",
    id: data.id,
    tokenId: data.id,
    label: data.name,
    workspaceId: data.workspace_id,
    scopes: data.scopes ?? [],
  };
}

async function verifySession(): Promise<Actor> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new AuthError();

  const { data: profile } = await supabase
    .from("profiles")
    .select("workspace_id, role, email, display_name")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) throw new AuthError("No workspace profile for this user");

  return {
    type: "user",
    id: user.id,
    label: profile.display_name || profile.email || user.email || user.id,
    workspaceId: profile.workspace_id,
    role: profile.role,
  };
}

/**
 * Assert the actor may perform `scope` (a `resource:action` string).
 * Tokens are checked against their granted scopes; users against their role
 * (viewers are read-only). Throws ScopeError (→ 403) otherwise.
 */
export function requireScope(actor: Actor, scope: string): void {
  if (actor.type === "token") {
    if (!hasScope(actor.scopes ?? [], scope)) {
      throw new ScopeError(`API token is missing required scope: ${scope}`);
    }
    return;
  }
  const action = scope.split(":")[1];
  if (actor.role === "viewer" && action && action !== "read") {
    throw new ScopeError("Viewers have read-only access");
  }
}

import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { hashToken, hasScope } from "@/lib/auth/tokens";
import { AuthError, RateLimitError, ScopeError } from "@/lib/api/errors";
import { ipRateKey } from "@/lib/api/client-ip";
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
  /**
   * The HUMAN behind this actor (a profiles.id), used by every four-eyes
   * comparison (2026-10-16, principal-aware four-eyes). Session users: their
   * own id. Bearer PATs: the token's `api_tokens.created_by`. Connector
   * actions (e.g. a Lark button click): the verified linked profile. Null
   * only for legacy tokens with no recorded creator — those can never
   * approve (fail-closed).
   */
  principalId?: string | null;
  /**
   * The current member_role of the human principal (principalId): session
   * users = their role; bearer PATs = the CURRENT role of api_tokens.created_by,
   * looked up at verify time; connector actors are set by the integration code.
   * Null when there is no principal (legacy token with no creator).
   */
  principalRole?: string | null;
  /** Set when the action arrived through an integration connector. */
  viaConnectorId?: string;
  /** The platform's event / callback id (non-repudiation, idempotency). */
  externalEventId?: string;
  /** The platform's user reference, e.g. "lark:<tenant_key>:<open_id>". */
  externalActorRef?: string;
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
    const actor = await verifyBearer(authz.slice(7).trim(), request.headers);
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

/** Do not rewrite api_tokens.last_used_at more often than this. */
const LAST_USED_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Failed bearer auth (unknown / revoked / expired token) budget per client
 * network (A1-8 / D-ACC-20). R-1: the lookup runs FIRST and only a FAILED
 * lookup is counted against the budget, so a valid token is never refused by
 * it. That matters because the remote MCP route and the assistant call this
 * API from the server's own outbound address, shared by every tenant: a flood
 * of garbage bearers through /api/mcp used to fill that one bucket and lock
 * every valid caller out. Now it only turns the garbage callers' 401s into 429s.
 * Needs a trustworthy client address (see @/lib/api/client-ip) - with none, the
 * cap is skipped rather than keyed on spoofable header text. Internal hops do
 * not forward the original client address in a signed way, so they are keyed on
 * the shared server address like any other caller; because valid tokens always
 * pass, that is harmless.
 */
const BEARER_FAIL_MAX = Number(process.env.NOPM_BEARER_FAIL_PER_MIN ?? 20);
const BEARER_FAIL_WINDOW_SECONDS = 60;

type RateResult = { allowed: boolean; retry_after_seconds: number };

/**
 * Count one failed bearer attempt for `key` and build the error to throw:
 * AuthError (401) normally, RateLimitError (429) once the budget is spent.
 * Fail-open on an RPC error (abuse guard, not the auth control itself - the
 * 192-bit token is).
 */
async function bearerFailure(
  admin: ReturnType<typeof createAdminClient>,
  key: string | null,
  message: string,
): Promise<AuthError | RateLimitError> {
  if (key) {
    try {
      const { data, error } = await admin.rpc("nopm_rate_check", {
        p_key: key,
        p_max: BEARER_FAIL_MAX,
        p_window_seconds: BEARER_FAIL_WINDOW_SECONDS,
      });
      const r = error ? null : (data as RateResult | null);
      if (r && r.allowed === false) {
        return new RateLimitError(
          `Too many failed API token attempts. Retry in ${r.retry_after_seconds}s.`,
          "rate_limited",
          r.retry_after_seconds,
        );
      }
    } catch {
      // Best-effort counter.
    }
  }
  return new AuthError(message);
}

/** True when a PostgREST error means profiles.status does not exist yet (migration 0083). */
function isMissingStatusColumn(error: { message?: string; code?: string } | null | undefined): boolean {
  return !!error && (error.code === "42703" || error.code === "PGRST204" || /column .*status/i.test(error.message ?? ""));
}

/** Q-ACC-24: one wording for a token that is revoked or past its expiry. */
export const DEAD_TOKEN_MESSAGE = "Token is revoked or expired.";

const DEAD_TOKEN_LOG_INTERVAL_MS = 60 * 60 * 1000;
const deadTokenLastLogged = new Map<string, number>();

/**
 * Q-ACC-24: log the FIRST use of a revoked/expired token per token per hour (id
 * only, never the secret), so a script still holding a dead token shows up once
 * instead of flooding the logs. The per-network failure budget (bearerFailure)
 * rate-limits the repeats. In-memory per instance: best-effort by design.
 */
export function logDeadTokenUse(tokenId: string, reason: "revoked" | "expired", now: number = Date.now()): boolean {
  const last = deadTokenLastLogged.get(tokenId);
  if (last !== undefined && now - last < DEAD_TOKEN_LOG_INTERVAL_MS) return false;
  if (deadTokenLastLogged.size > 5000) deadTokenLastLogged.clear();
  deadTokenLastLogged.set(tokenId, now);
  console.warn("[nopm][auth] revoked/expired API token presented", { tokenId, reason });
  return true;
}

async function verifyBearer(raw: string, headers: Headers = new Headers()): Promise<Actor> {
  const admin = createAdminClient();
  const ip = ipRateKey(headers);
  const failKey = ip ? `bearer-fail:${ip}` : null;

  const { data, error } = await admin
    .from("api_tokens")
    .select("id, workspace_id, name, scopes, revoked, expires_at, created_by, last_used_at")
    .eq("token_hash", hashToken(raw))
    .maybeSingle();

  if (error || !data) throw await bearerFailure(admin, failKey, "Invalid API token");
  if (data.revoked) {
    logDeadTokenUse(data.id, "revoked");
    throw await bearerFailure(admin, failKey, DEAD_TOKEN_MESSAGE);
  }
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    logDeadTokenUse(data.id, "expired");
    throw await bearerFailure(admin, failKey, DEAD_TOKEN_MESSAGE);
  }

  // A token is its creator's delegate: when that person's profile no longer
  // exists in this workspace the token stops working (D-ACC-2 / A1-4 / A2-6).
  // Legacy tokens with no recorded creator (created_by null) keep working but
  // can never approve (R-10: fail-closed by design; re-mint
  // such a token to give it a principal). This lookup also yields the creator's CURRENT role
  // (principalRole). Calendar feeds are deliberately NOT checked (decision 9).
  let principalRole: string | null = null;
  if (data.created_by) {
    const { error: creatorError, data: creatorFirst } = await admin
      .from("profiles")
      .select("workspace_id, role, status")
      .eq("id", data.created_by)
      .maybeSingle();
    let creator = creatorFirst;
    if (creatorError && !isMissingStatusColumn(creatorError)) throw creatorError; // fail closed: never guess a role
    if (creatorError) {
      // profiles.status not there yet (0083 not applied): re-read without it.
      const retry = await admin.from("profiles").select("workspace_id, role").eq("id", data.created_by).maybeSingle();
      if (retry.error) throw retry.error;
      creator = retry.data as typeof creator;
    }
    if (!creator || creator.workspace_id !== data.workspace_id || creator.status === "removed") {
      throw new AuthError("The person who created this API token no longer has access to this workspace");
    }
    principalRole = creator.role ?? null;
  }

  // Fire-and-forget last_used_at. supabase-js builders are lazy thenables:
  // nothing is sent until `.then()` is called, so a bare `void builder` never
  // wrote (the Tokens page always said "never"). Skip the write while the
  // stored value is under TOUCH_INTERVAL_MS old, so a busy agent does not
  // turn every request into an extra UPDATE.
  const lastUsed = data.last_used_at ? Date.parse(data.last_used_at) : NaN;
  if (!Number.isFinite(lastUsed) || Date.now() - lastUsed >= LAST_USED_TOUCH_INTERVAL_MS) {
    admin
      .from("api_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", data.id)
      .then(
        () => {},
        () => {},
      );
  }

  return {
    type: "token",
    id: data.id,
    tokenId: data.id,
    label: data.name,
    workspaceId: data.workspace_id,
    scopes: data.scopes ?? [],
    // The human who minted this token (api_tokens.created_by). Four-eyes
    // compares HUMANS, never actor ids: a person's token is that person, so
    // it can never approve what the person (or another of their tokens)
    // raised. NULL for legacy tokens with no recorded creator — those can
    // never approve (fail-closed, enforced in @/lib/governance/decide).
    principalId: data.created_by ?? null,
    principalRole,
  };
}

async function verifySession(): Promise<Actor> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new AuthError();

  const { data: profileFirst, error: profileError } = await supabase
    .from("profiles")
    .select("workspace_id, role, email, display_name, status")
    .eq("id", user.id)
    .maybeSingle();
  let profile = profileFirst;
  if (profileError && isMissingStatusColumn(profileError)) {
    // profiles.status not there yet (0083 not applied): everyone is active.
    ({ data: profile } = (await supabase
      .from("profiles")
      .select("workspace_id, role, email, display_name")
      .eq("id", user.id)
      .maybeSingle()) as { data: typeof profile });
  }
  if (!profile) throw new AuthError("No workspace profile for this user");
  // A removed person's session stops working at once (the login is banned too).
  if ((profile as { status?: string }).status === "removed") throw new AuthError("This account has been removed from the workspace");

  return {
    type: "user",
    id: user.id,
    label: profile.display_name || profile.email || user.email || user.id,
    workspaceId: profile.workspace_id,
    role: profile.role,
    // A signed-in person is their own principal.
    principalId: user.id,
    principalRole: profile.role ?? null,
  };
}

/**
 * Assert the actor may perform `scope` (a `resource:action` string).
 * Tokens are checked against their granted scopes; users against their role
 * (viewers are read-only). Throws ScopeError (→ 403) otherwise.
 */
export function requireScope(actor: Actor, scope: string): void {
  const action = scope.split(":")[1];
  if (actor.type === "token") {
    if (!hasScope(actor.scopes ?? [], scope)) {
      throw new ScopeError(`API token is missing required scope: ${scope}`);
    }
    // R-6: a token follows its creator's CURRENT role. A creator who has been
    // demoted to viewer leaves every PAT they minted read-only, the same rule
    // as a viewer session below. (Approve verbs are governed separately by
    // requireApprover on principalRole.)
    if (actor.principalRole === "viewer" && action && action !== "read") {
      throw new ScopeError("This token's creator now has read-only access; the token is read-only");
    }
    return;
  }
  if (actor.role === "viewer" && action && action !== "read") {
    throw new ScopeError("Viewers have read-only access");
  }
}

import { route } from "@/lib/api/handler";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { RateLimitError } from "@/lib/api/errors";
import { ipRateKey } from "@/lib/api/client-ip";
import { hashToken } from "@/lib/auth/tokens";
import { assertInviteAcceptable, throwInviteNotAcceptable } from "@/lib/governance/invite-guard";
import { performInviteAccept } from "@/lib/governance/invite-accept";
import { resolveClientMeta } from "@/lib/audit/channel";
import { acceptInviteSchema } from "../_schema";

export const runtime = "nodejs";

const RATE_MAX = 10;
const RATE_WINDOW_SECONDS = 60;

async function enforceRate(db: ReturnType<typeof createAdminClient>, key: string): Promise<void> {
  const { data: rateData, error: rateError } = await db.rpc("nopm_rate_check", {
    p_key: key,
    p_max: RATE_MAX,
    p_window_seconds: RATE_WINDOW_SECONDS,
  });
  if (rateError) {
    // Fail-open (abuse protection, not an auth control) — loud in logs so
    // an unenforced cap shows up as an anomaly, not a silent gap.
    console.error(
      "[nopm][invite-accept] nopm_rate_check RPC failed — FAILING OPEN (cap not enforced this call)",
      { key: key.startsWith("invite-accept:tok:") ? "invite-accept:tok" : key, error: rateError.message },
    );
    return;
  }
  const rate = rateData as { allowed: boolean; retry_after_seconds: number };
  if (!rate.allowed) {
    throw new RateLimitError(`Rate limit exceeded. Retry in ${rate.retry_after_seconds}s.`);
  }
}

/**
 * POST /api/invites/accept — public (auth:false, D6/D13). This is the ONE
 * route in NoPM that provisions a brand-new auth.users row from an
 * unauthenticated request, so it gets its OWN explicit abuse guard: route()
 * skips its actor-keyed limiter entirely when auth:false (there is no actor
 * to key on pre-auth — recon-identity.md §7 "sharp edge"), so this handler
 * calls nopm_rate_check directly, keyed on the caller's IP rather than a
 * workspace/actor — fail-open on RPC error, same baseline posture as
 * lib/api/rate-limit.ts.
 *
 * Ordering (D6): admin.auth.admin.createUser FIRST (inside
 * performInviteAccept), THEN the atomic nopm_accept_invite RPC. The client
 * NEVER receives a server-minted session here — it signs in normally via
 * /login afterwards (no auto-session, per D6/T7).
 */
export const POST = route(
  async ({ request }) => {
    const db = createAdminClient();

    // Explicit rate limit (10/min) — this endpoint mints new Supabase auth
    // users, so it cannot be left unguarded just because it has no actor to key
    // route()'s baseline limiter on.
    // The address comes from @/lib/api/client-ip, never from the caller's own
    // X-Forwarded-For (rotating it gave every request a fresh bucket). When no
    // address can be trusted the bucket is keyed on a hash of the invite token
    // being accepted instead of one shared "unknown" bucket: a flood then only
    // throttles the token it is aimed at, not every legitimate acceptance.
    const body = await safeJson(request);
    const ip = ipRateKey(request.headers);
    const rawToken =
      body && typeof body === "object" && typeof (body as { token?: unknown }).token === "string"
        ? (body as { token: string }).token
        : null;
    // No address and no token: nothing to key on, and the request is about to be
    // refused as a validation error before any database work or user creation.
    const rateKey = ip ? `invite-accept:${ip}` : rawToken ? `invite-accept:tok:${hashToken(rawToken)}` : null;
    if (rateKey) await enforceRate(db, rateKey);

    const parsed = acceptInviteSchema.safeParse(body);
    if (!parsed.success) {
      return validationError(
        "Validation failed",
        parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
      );
    }

    const tokenHash = hashToken(parsed.data.token);

    // Pre-validate for a clean error before ever calling createUser (T7) —
    // the RPC re-validates under FOR UPDATE regardless (TOCTOU-safe).
    const { data: invite, error: loadError } = await db
      .from("invites")
      .select("id, workspace_id, email, revoked, accepted_at, expires_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (loadError) throw loadError;
    // T3 (F2c-mini) anti-enumeration: a missing token throws the exact same
    // shape as an expired/used/revoked one — see invite-guard.ts's
    // INVITE_ACCEPT_ERROR_MESSAGE comment for the full rationale.
    if (!invite) throwInviteNotAcceptable();

    assertInviteAcceptable(invite);

    // R-84: this route runs with { auth: false } (anonymous acceptor) — no
    // session/token Actor exists yet to read channel/requestId off, so they
    // are resolved directly from the request headers, same inputs
    // resolveClientMeta uses inside requireAuth for every other route.
    const { channel, requestId } = resolveClientMeta(request.headers, "user");

    const result = await performInviteAccept(db, {
      tokenHash,
      email: invite.email, // ALWAYS the invite's own email (D6) — never client-supplied
      password: parsed.data.password,
      displayName: parsed.data.display_name,
      channel,
      requestId,
    });

    const { data: workspace } = await db
      .from("workspaces")
      .select("id, name")
      .eq("id", result.workspace_id)
      .maybeSingle();

    // No server-minted session — the client signs in normally via /login.
    return ok({ workspace: workspace ?? { id: result.workspace_id, name: null }, email: invite.email });
  },
  { auth: false },
);

import { cookies } from "next/headers";
import { route } from "@/lib/api/handler";
import { AuthError, RateLimitError, RuleError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { decrypt } from "@/lib/crypto";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { issueMfaCookie, computeEnrollmentBinding, MFA_COOKIE_NAME } from "@/lib/auth/mfa";
import { consumeTotp, hashBackupCode, spendMfaAttempt } from "@/lib/auth/mfa-factor";
import { challengeMfaSchema } from "../_schema";
import { mfaChallenge } from "../_rpc";

export const runtime = "nodejs";

const ATTEMPT_LIMIT = 5;
const ATTEMPT_WINDOW_MINUTES = 10;

/**
 * POST /api/auth/mfa/challenge — R-91. Verifies a TOTP code (or consumes
 * one unused backup code) for the just-signed-in session and, on success,
 * issues the `nopm_mfa` cookie that guard.ts's `requireAuth` checks on
 * every subsequent request. This route itself is exempt from that same
 * check (see guard.ts's MFA_CHALLENGE_EXEMPT_PATHS) — otherwise an enrolled
 * user could never reach the endpoint that lets them satisfy it.
 */
export const POST = route(async ({ actor, request }) => {
  if (actor.type !== "user") {
    throw new AuthError("MFA requires a user session");
  }

  const body = await safeJson(request);
  const parsed = challengeMfaSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    );
  }
  const code = parsed.data.code;

  const db = createAdminClient();

  // D-ACC-19: shared per-account attempt budget (all outcomes count) -> 429 + Retry-After.
  await spendMfaAttempt(db, actor.id);

  // Attempt cap: 5 failed challenges per 10 minutes per user. No dedicated
  // counter table — this is the only caller of `auth.mfa.challenge_failed`,
  // so a short-window count query against audit_log is cheap and needs no
  // new schema (per R-91 spec).
  const windowStart = new Date(Date.now() - ATTEMPT_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { count, error: countError } = await db
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("actor_id", actor.id)
    .eq("action", "auth.mfa.challenge_failed")
    .gte("created_at", windowStart);
  if (countError) throw countError;
  if ((count ?? 0) >= ATTEMPT_LIMIT) {
    throw new RateLimitError(
      `Too many MFA attempts. Try again in ${ATTEMPT_WINDOW_MINUTES} minutes.`,
      "rate_limited",
      ATTEMPT_WINDOW_MINUTES * 60,
    );
  }

  const { data: mfa, error: fetchError } = await db
    .from("user_mfa")
    .select("totp_secret, enabled, backup_codes, enrolled_at")
    .eq("user_id", actor.id)
    .maybeSingle();
  if (fetchError) throw fetchError;

  if (!mfa?.enabled || !mfa.totp_secret) {
    throw new RuleError("MFA is not enabled for this account.");
  }

  // Secret is AES-GCM encrypted (3 dot-separated segments) — same legacy
  // fallback verify/route.ts uses for a pre-encryption enrollment.
  const secret =
    mfa.totp_secret.split(".").length === 3 ? decrypt(mfa.totp_secret) : mfa.totp_secret;
  // A correct code whose 30-second step was already used is a replay (D-ACC-19):
  // treated exactly like a wrong code (audited as challenge_failed, counts toward the cap).
  const totp = await consumeTotp(db, actor.id, secret, code);
  const validTotp = totp === "ok";

  const backupCodes: string[] = mfa.backup_codes ?? [];
  const codeHash = hashBackupCode(code);
  const usedBackupCode = !validTotp && backupCodes.includes(codeHash);

  if (!validTotp && !usedBackupCode) {
    // One audit row, nothing else to change. The attempt budget and the step burn were spent above,
    // outside this call, so they keep counting even if this audit write fails.
    await mfaChallenge(db, actor, "failed");
    throw new RuleError("Invalid code");
  }

  // The outcome is recorded by ONE database function (migration 0109): burning a backup code and the audit
  // row are one transaction, so a code can never be spent without its audit row. Audit BEFORE credential: the
  // cookie is staged only after this call has durably succeeded.
  if (usedBackupCode) {
    // The function burns the code with a compare-and-set (Postgres array containment): two requests holding the
    // same still-valid code race on it, only the first matches, the second comes back "failed" and is audited
    // as a failed challenge instead of passing twice.
    const result = await mfaChallenge(db, actor, "backup_code", codeHash);
    if (result === "failed") throw new RuleError("Invalid code");
  } else {
    await mfaChallenge(db, actor, "totp");
  }

  // Cap the cookie at the underlying Supabase session's own expiry (never
  // outlive the session) as well as the flat 12h ceiling in mfa.ts.
  let sessionExp: number | null = null;
  try {
    const supabase = await createServerClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    sessionExp = session?.expires_at ?? null;
  } catch {
    sessionExp = null; // fall back to the flat 12h ceiling
  }

  const enr = computeEnrollmentBinding(mfa.enrolled_at);
  const { value, maxAgeSeconds } = issueMfaCookie(actor.id, enr, sessionExp);

  const store = await cookies();
  store.set(MFA_COOKIE_NAME, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });

  return ok({ satisfied: true });
});

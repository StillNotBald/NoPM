/**
 * Second-factor primitives shared by the /api/auth/mfa/* routes (D-ACC-5,
 * D-ACC-19): single-use TOTP codes, backup-code matching and a per-account
 * attempt budget. Kept apart from ./mfa (cookie signing) so each can be tested
 * without the other's mocks.
 */
import { authenticator } from "otplib";
import { createHash } from "node:crypto";
import type { createAdminClient } from "@/lib/supabase/admin";
import { RateLimitError } from "@/lib/api/errors";

type Db = ReturnType<typeof createAdminClient>;

/** TOTP step length in seconds (otplib default; RFC 6238). */
const TOTP_STEP_SECONDS = 30;

/** Attempts (right or wrong) per account per window on verify / challenge / disable. */
export const MFA_ATTEMPT_MAX = 10;
export const MFA_ATTEMPT_WINDOW_SECONDS = 300;

/**
 * Spend one attempt from the account's budget (10 per 5 minutes, shared by
 * /mfa/verify, /mfa/challenge and /mfa/disable) via the DB-backed counter. A
 * 6-digit code has only a million values, so an unthrottled signed-in session
 * could otherwise guess one. Throws RateLimitError (429 + Retry-After).
 * Fail-OPEN on an RPC error, like the other baseline limiters (logged loudly).
 */
export async function spendMfaAttempt(db: Db, userId: string): Promise<void> {
  const { data, error } = await db.rpc("nopm_rate_check", {
    p_key: `mfa-attempt:${userId}`,
    p_max: MFA_ATTEMPT_MAX,
    p_window_seconds: MFA_ATTEMPT_WINDOW_SECONDS,
  });
  if (error) {
    console.error("[nopm][mfa] nopm_rate_check RPC failed — FAILING OPEN (attempt cap not enforced this call)", {
      error: error.message,
    });
    return;
  }
  const r = data as { allowed: boolean; retry_after_seconds: number };
  if (!r.allowed) {
    throw new RateLimitError(
      `Too many two-step attempts. Try again in ${r.retry_after_seconds}s.`,
      "rate_limited",
      r.retry_after_seconds,
    );
  }
}

export type TotpOutcome = "ok" | "invalid" | "replay";

/**
 * Check a TOTP code and, if it is valid, burn its time-step so the same code
 * cannot be used again (D-ACC-19). The burn is one conditional UPDATE
 * (`last_totp_step` null or lower than this step) so two concurrent submissions
 * of one code cannot both succeed. Returns "replay" for a correct code whose
 * step was already used.
 */
export async function consumeTotp(db: Db, userId: string, secret: string, code: string): Promise<TotpOutcome> {
  let delta: number | null;
  try {
    delta = authenticator.checkDelta(code, secret);
  } catch {
    return "invalid"; // malformed token / secret
  }
  if (delta === null) return "invalid";

  const step = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + delta;
  const { data, error } = await db
    .from("user_mfa")
    .update({ last_totp_step: step })
    .eq("user_id", userId)
    .or(`last_totp_step.is.null,last_totp_step.lt.${step}`)
    .select("user_id");
  if (error) {
    // R-8: build deployed before migration 0060 (user_mfa.last_totp_step). The
    // code itself is valid, so accept it without the replay guard rather than
    // 500 every sign-in of every two-step user. Logged once per process.
    if (isMissingTotpStepColumn(error)) {
      warnMissingTotpStepOnce();
      return "ok";
    }
    throw error;
  }
  return data && data.length > 0 ? "ok" : "replay";
}

/** True when a PostgREST/Postgres error says user_mfa.last_totp_step does not exist (migration 0060 not applied). */
export function isMissingTotpStepColumn(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false;
  return /last_totp_step/i.test(error.message ?? "") && (/column|schema cache/i.test(error.message ?? "") || error.code === "42703" || error.code === "PGRST204");
}

let warnedMissingTotpStep = false;
function warnMissingTotpStepOnce(): void {
  if (warnedMissingTotpStep) return;
  warnedMissingTotpStep = true;
  console.error(
    "[nopm][mfa] user_mfa.last_totp_step is missing (migration 20261017000060 not applied): TOTP replay guard is OFF. Apply migrations BEFORE deploying the build.",
  );
}

/** Test seam. */
export function resetMissingTotpStepWarning(): void {
  warnedMissingTotpStep = false;
}

export function hashBackupCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** True when `code` matches one of the stored (SHA-256) unused backup-code hashes. */
export function matchesBackupCode(code: string, storedHashes: readonly string[] | null | undefined): boolean {
  return (storedHashes ?? []).includes(hashBackupCode(code));
}


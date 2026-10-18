import { cookies } from "next/headers";
import { authenticator } from "otplib";
import { route } from "@/lib/api/handler";
import { AuthError, ConflictError, ScopeError } from "@/lib/api/errors";
import { DEMO_RESTRICTED_MESSAGE, isDemoActor } from "@/lib/auth/demo";
import { getMfaEnrollmentStatus, isRecentMfaChallenge, MFA_COOKIE_NAME } from "@/lib/auth/mfa";
import { isMissingTotpStepColumn } from "@/lib/auth/mfa-factor";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { decrypt, encrypt } from "@/lib/crypto";
import { ok } from "@/lib/api/response";

export const runtime = "nodejs";

/** A not-yet-confirmed enrolment is reused for this long (Q-WRK-26). */
const PENDING_ENROLMENT_MS = 60 * 60 * 1000;

// POST /api/auth/mfa/enroll — generate a TOTP secret and upsert user_mfa
export const POST = route(async ({ actor }) => {
  if (actor.type !== "user") {
    throw new AuthError("MFA requires a user session");
  }

  // R-5: the shared demo login must never turn two-step on (every other
  // visitor would then be asked for a code nobody has).
  if (await isDemoActor(actor)) throw new ScopeError(DEMO_RESTRICTED_MESSAGE, "demo_restricted");

  const db = createAdminClient();

  // D-ACC-4: re-enrolling while two-step is ON silently replaced the live
  // factor (and dropped the backup codes) for a mere session. Turn it off
  // first (which now needs a code), then enroll.
  const { data: existing, error: existingError } = await db
    .from("user_mfa")
    .select("enabled, totp_secret, enrolled_at")
    .eq("user_id", actor.id)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.enabled) {
    // R-4: a challenge passed in the last 10 minutes counts as proof of the
    // factor, so someone who just spent their last backup code can re-enrol on
    // a new phone instead of being locked out. Without it: turn it off first.
    const { enr } = await getMfaEnrollmentStatus(actor.id);
    const store = await cookies();
    if (enr === null || !isRecentMfaChallenge(store.get(MFA_COOKIE_NAME)?.value, actor.id, enr)) {
      throw new ConflictError("Two-step is already on. Turn it off first.", "mfa_already_enabled");
    }
  }

  // Q-WRK-26: a second tab (or a double press) while a recent enrolment is still
  // waiting for its first code gets the SAME secret back, so the QR the first tab
  // shows keeps working. Nothing is written, so no audit row.
  const pendingAge = existing?.enrolled_at ? Date.now() - Date.parse(existing.enrolled_at) : Infinity;
  if (existing && !existing.enabled && existing.totp_secret && pendingAge >= 0 && pendingAge <= PENDING_ENROLMENT_MS) {
    try {
      const pendingSecret =
        existing.totp_secret.split(".").length === 3 ? decrypt(existing.totp_secret) : existing.totp_secret;
      return ok({ secret: pendingSecret, otpauth: authenticator.keyuri(actor.label, "NoPM", pendingSecret) });
    } catch {
      // unreadable secret: fall through and start a fresh enrolment
    }
  }

  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(actor.label, "NoPM", secret);

  const row = {
    user_id: actor.id,
    // Encrypted at rest (AES-256-GCM) — never store the live TOTP seed plaintext.
    totp_secret: encrypt(secret),
    enabled: false,
    // clear any stale backup codes and confirmed_at from a previous enrollment
    backup_codes: null,
    confirmed_at: null,
    enrolled_at: new Date().toISOString(),
  };
  let { error } = await db.from("user_mfa").upsert({ ...row, last_totp_step: null }, { onConflict: "user_id" });
  // R-8: migration 0060 not applied yet - retry without the new column.
  if (error && isMissingTotpStepColumn(error)) {
    ({ error } = await db.from("user_mfa").upsert(row, { onConflict: "user_id" }));
  }

  if (error) throw error;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "mfa.enroll_started",
    targetType: "user_mfa",
    targetId: actor.id,
    before: null,
    after: { enabled: false },
  });

  return ok({ secret, otpauth });
});

import { cookies } from "next/headers";
import { route } from "@/lib/api/handler";
import { AuthError, NotFoundError, RuleError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { decrypt } from "@/lib/crypto";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { MFA_COOKIE_NAME } from "@/lib/auth/mfa";
import { consumeTotp, matchesBackupCode, spendMfaAttempt } from "@/lib/auth/mfa-factor";
import { disableMfaSchema } from "../_schema";

export const runtime = "nodejs";

/**
 * POST /api/auth/mfa/disable — disable MFA and clear TOTP secret + backup codes.
 *
 * D-ACC-5: while two-step is ON, the body must carry `{ code }` — a current
 * TOTP code or an unused backup code. A bare signed-in session (a stolen
 * cookie, an unattended laptop) can no longer strip the second factor. A
 * missing or wrong code is 422 and is audited (`auth.mfa.disable_failed`).
 * A not-yet-confirmed enrollment (enabled = false) can be cancelled without a
 * code, since nothing is protected yet.
 */
export const POST = route(async ({ actor, request }) => {
  if (actor.type !== "user") {
    throw new AuthError("MFA requires a user session");
  }

  const db = createAdminClient();

  // Fetch current state for audit before snapshot
  const { data: mfa, error: fetchError } = await db
    .from("user_mfa")
    .select("enabled, totp_secret, backup_codes")
    .eq("user_id", actor.id)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!mfa) {
    throw new NotFoundError("No MFA record found for this user.");
  }

  if (mfa.enabled) {
    await spendMfaAttempt(db, actor.id);

    const parsed = disableMfaSchema.safeParse(await safeJson(request));
    if (!parsed.success) {
      return validationError("A current two-step code or a backup code is required to turn two-step off", [
        { field: "code", message: "enter a current code from your authenticator, or an unused backup code" },
      ]);
    }
    const code = parsed.data.code;

    const secret = mfa.totp_secret.split(".").length === 3 ? decrypt(mfa.totp_secret) : mfa.totp_secret;
    const totp = secret ? await consumeTotp(db, actor.id, secret, code) : "invalid";
    if (totp !== "ok" && !matchesBackupCode(code, mfa.backup_codes)) {
      await writeAudit({
        workspaceId: actor.workspaceId,
        actor,
        action: "auth.mfa.disable_failed",
        targetType: "user_mfa",
        targetId: actor.id,
        before: null,
        after: null,
      });
      throw new RuleError("Invalid code");
    }
  }

  const { error: updateError } = await db
    .from("user_mfa")
    .update({
      enabled: false,
      // `totp_secret` is NOT NULL (supabase/migrations/20260608000002_identity.sql)
      // — writing null here would fail the DB constraint and 500 this whole
      // route. An empty string is not a valid decryptable secret (and this
      // path is unreachable anyway once `enabled` is false), so it wipes the
      // factor material without violating the column's NOT NULL constraint.
      totp_secret: "",
      backup_codes: null,
      last_totp_step: null,
    })
    .eq("user_id", actor.id);

  if (updateError) throw updateError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "mfa.disabled",
    targetType: "user_mfa",
    targetId: actor.id,
    before: { enabled: mfa.enabled },
    after: { enabled: false },
  });

  // R-91 — a previously issued nopm_mfa cookie is signature-bound to this
  // enrollment's `enr` value, which does not change on disable alone (only
  // on the *next* enroll). Clear it here too so the same browser can never
  // carry a stale satisfied-challenge cookie forward, independent of the
  // enrollment-binding check (verified-adversarial finding, defense in depth).
  const store = await cookies();
  store.delete({ name: MFA_COOKIE_NAME, path: "/" });

  return ok({ enabled: false });
});

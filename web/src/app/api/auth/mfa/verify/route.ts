import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { route } from "@/lib/api/handler";
import { AuthError, NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { DEMO_RESTRICTED_MESSAGE, isDemoActor } from "@/lib/auth/demo";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { decrypt } from "@/lib/crypto";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { MFA_COOKIE_NAME } from "@/lib/auth/mfa";
import { consumeTotp, spendMfaAttempt } from "@/lib/auth/mfa-factor";
import { verifyMfaSchema } from "../_schema";

export const runtime = "nodejs";

// POST /api/auth/mfa/verify — confirm TOTP code, enable MFA, return one-time backup codes
export const POST = route(async ({ actor, request }) => {
  if (actor.type !== "user") {
    throw new AuthError("MFA requires a user session");
  }

  // R-5: the shared demo login can never enable two-step.
  if (await isDemoActor(actor)) throw new ScopeError(DEMO_RESTRICTED_MESSAGE, "demo_restricted");

  const body = await safeJson(request);
  const parsed = verifyMfaSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    );
  }

  const db = createAdminClient();
  // D-ACC-19: bounded guessing (10 attempts / 5 min / account) -> 429 + Retry-After.
  await spendMfaAttempt(db, actor.id);

  const { data: mfa, error: fetchError } = await db
    .from("user_mfa")
    .select("totp_secret, enabled")
    .eq("user_id", actor.id)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!mfa?.totp_secret) {
    throw new NotFoundError("No pending MFA enrollment found. Call /enroll first.");
  }

  // Secret is AES-GCM encrypted (3 dot-separated segments). Fall back to the raw
  // value for any legacy plaintext enrollment created before encryption-at-rest.
  const secret = mfa.totp_secret.split(".").length === 3 ? decrypt(mfa.totp_secret) : mfa.totp_secret;
  // D-ACC-19: the code's 30-second step is burned on success, so it cannot be replayed.
  const outcome = await consumeTotp(db, actor.id, secret, parsed.data.code);
  if (outcome !== "ok") {
    await writeAudit({
      workspaceId: actor.workspaceId,
      actor,
      action: "auth.mfa.verify_failed",
      targetType: "user_mfa",
      targetId: actor.id,
      before: null,
      after: { reason: outcome },
    });
    throw new RuleError(outcome === "replay" ? "That code was already used. Wait for the next one." : "Invalid code");
  }

  // Generate 8 backup codes as random hex strings (16 bytes each = 32 hex chars)
  const backupCodes: string[] = Array.from({ length: 8 }, () =>
    randomBytes(16).toString("hex"),
  );

  // Store only SHA-256 hashes
  const backupCodeHashes = backupCodes.map((code) =>
    createHash("sha256").update(code).digest("hex"),
  );

  const now = new Date().toISOString();
  const { error: updateError } = await db
    .from("user_mfa")
    .update({
      enabled: true,
      backup_codes: backupCodeHashes,
      confirmed_at: now,
    })
    .eq("user_id", actor.id);

  if (updateError) throw updateError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "mfa.enabled",
    targetType: "user_mfa",
    targetId: actor.id,
    before: { enabled: mfa.enabled },
    after: { enabled: true },
  });

  // R-91 — this is a (re-)enrollment: `user_mfa.enrolled_at` was set to a
  // fresh timestamp by /enroll, which changes the `enr` binding a nopm_mfa
  // cookie must carry. A cookie issued against a prior enrollment will
  // already fail the `enr` check, but clear it here too so the same browser
  // never carries a now-meaningless satisfied-challenge cookie forward
  // (verified-adversarial finding, defense in depth).
  const store = await cookies();
  store.delete({ name: MFA_COOKIE_NAME, path: "/" });

  return ok({ enabled: true, backupCodes });
});

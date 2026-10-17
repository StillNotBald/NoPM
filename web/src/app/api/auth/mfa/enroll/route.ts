import { authenticator } from "otplib";
import { route } from "@/lib/api/handler";
import { AuthError, ConflictError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { encrypt } from "@/lib/crypto";
import { ok } from "@/lib/api/response";

export const runtime = "nodejs";

// POST /api/auth/mfa/enroll — generate a TOTP secret and upsert user_mfa
export const POST = route(async ({ actor }) => {
  if (actor.type !== "user") {
    throw new AuthError("MFA requires a user session");
  }

  const db = createAdminClient();

  // D-ACC-4: re-enrolling while two-step is ON silently replaced the live
  // factor (and dropped the backup codes) for a mere session. Turn it off
  // first (which now needs a code), then enroll.
  const { data: existing, error: existingError } = await db
    .from("user_mfa")
    .select("enabled")
    .eq("user_id", actor.id)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.enabled) {
    throw new ConflictError("Two-step is already on. Turn it off first.", "mfa_already_enabled");
  }

  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(actor.label, "NoPM", secret);

  const { error } = await db.from("user_mfa").upsert(
    {
      user_id: actor.id,
      // Encrypted at rest (AES-256-GCM) — never store the live TOTP seed plaintext.
      totp_secret: encrypt(secret),
      enabled: false,
      // clear any stale backup codes and confirmed_at from a previous enrollment
      backup_codes: null,
      confirmed_at: null,
      last_totp_step: null,
      enrolled_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

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

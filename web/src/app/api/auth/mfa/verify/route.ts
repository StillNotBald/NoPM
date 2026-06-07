import { authenticator } from "otplib";
import { createHash, randomBytes } from "node:crypto";
import { route } from "@/lib/api/handler";
import { AuthError, NotFoundError, RuleError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { verifyMfaSchema } from "../_schema";

export const runtime = "nodejs";

// POST /api/auth/mfa/verify — confirm TOTP code, enable MFA, return one-time backup codes
export const POST = route(async ({ actor, request }) => {
  if (actor.type !== "user") {
    throw new AuthError("MFA requires a user session");
  }

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
  const { data: mfa, error: fetchError } = await db
    .from("user_mfa")
    .select("totp_secret, enabled")
    .eq("user_id", actor.id)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!mfa?.totp_secret) {
    throw new NotFoundError("No pending MFA enrollment found. Call /enroll first.");
  }

  const valid = authenticator.verify({ token: parsed.data.code, secret: mfa.totp_secret });
  if (!valid) {
    throw new RuleError("Invalid code");
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

  return ok({ enabled: true, backupCodes });
});

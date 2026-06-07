import { authenticator } from "otplib";
import { route } from "@/lib/api/handler";
import { AuthError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok } from "@/lib/api/response";

export const runtime = "nodejs";

// POST /api/auth/mfa/enroll — generate a TOTP secret and upsert user_mfa
export const POST = route(async ({ actor }) => {
  if (actor.type !== "user") {
    throw new AuthError("MFA requires a user session");
  }

  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(actor.label, "NoPM", secret);

  const db = createAdminClient();
  const { error } = await db.from("user_mfa").upsert(
    {
      user_id: actor.id,
      totp_secret: secret,
      enabled: false,
      // clear any stale backup codes and confirmed_at from a previous enrollment
      backup_codes: null,
      confirmed_at: null,
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

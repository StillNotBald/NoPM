import { route } from "@/lib/api/handler";
import { AuthError, NotFoundError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok } from "@/lib/api/response";

export const runtime = "nodejs";

// POST /api/auth/mfa/disable — disable MFA and clear TOTP secret + backup codes
export const POST = route(async ({ actor }) => {
  if (actor.type !== "user") {
    throw new AuthError("MFA requires a user session");
  }

  const db = createAdminClient();

  // Fetch current state for audit before snapshot
  const { data: mfa, error: fetchError } = await db
    .from("user_mfa")
    .select("enabled")
    .eq("user_id", actor.id)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!mfa) {
    throw new NotFoundError("No MFA record found for this user.");
  }

  const { error: updateError } = await db
    .from("user_mfa")
    .update({
      enabled: false,
      totp_secret: null,
      backup_codes: null,
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

  return ok({ enabled: false });
});

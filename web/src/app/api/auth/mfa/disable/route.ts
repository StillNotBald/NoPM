import { cookies } from "next/headers";
import { route } from "@/lib/api/handler";
import { AuthError, NotFoundError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok } from "@/lib/api/response";
import { MFA_COOKIE_NAME } from "@/lib/auth/mfa";

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
      // `totp_secret` is NOT NULL (supabase/migrations/20260608000002_identity.sql)
      // — writing null here would fail the DB constraint and 500 this whole
      // route. An empty string is not a valid decryptable secret (and this
      // path is unreachable anyway once `enabled` is false), so it wipes the
      // factor material without violating the column's NOT NULL constraint.
      totp_secret: "",
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

  // R-91 — a previously issued nopm_mfa cookie is signature-bound to this
  // enrollment's `enr` value, which does not change on disable alone (only
  // on the *next* enroll). Clear it here too so the same browser can never
  // carry a stale satisfied-challenge cookie forward, independent of the
  // enrollment-binding check (verified-adversarial finding, defense in depth).
  const store = await cookies();
  store.delete({ name: MFA_COOKIE_NAME, path: "/" });

  return ok({ enabled: false });
});

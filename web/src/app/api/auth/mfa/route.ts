import { cookies } from "next/headers";
import { route } from "@/lib/api/handler";
import { AuthError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok } from "@/lib/api/response";
import { MFA_COOKIE_NAME, verifyMfaCookie, computeEnrollmentBinding } from "@/lib/auth/mfa";

export const runtime = "nodejs";

// GET /api/auth/mfa — return MFA status for the current user session.
// This route is exempt from guard.ts's own MFA-challenge gate (see
// MFA_CHALLENGE_EXEMPT_PATHS) so the login page can poll it BEFORE the
// challenge cookie exists to decide whether to show the code step (R-91).
//
// `enabled` is kept for the existing settings-page consumer; `enrolled`
// (same value) + `satisfied` are additive for the login-page challenge flow.
export const GET = route(async ({ actor }) => {
  if (actor.type !== "user") {
    throw new AuthError("MFA requires a user session");
  }

  const db = createAdminClient();
  const { data, error } = await db
    .from("user_mfa")
    .select("enabled, enrolled_at")
    .eq("user_id", actor.id)
    .maybeSingle();

  if (error) throw error;

  const enabled = data?.enabled ?? false;
  let satisfied = true;
  if (enabled && data?.enrolled_at) {
    const store = await cookies();
    const enr = computeEnrollmentBinding(data.enrolled_at);
    satisfied = verifyMfaCookie(store.get(MFA_COOKIE_NAME)?.value, actor.id, enr);
  }

  return ok({ enabled, enrolled: enabled, satisfied });
});

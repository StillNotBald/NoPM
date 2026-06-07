import { route } from "@/lib/api/handler";
import { AuthError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok } from "@/lib/api/response";

export const runtime = "nodejs";

// GET /api/auth/mfa — return MFA status for the current user session
export const GET = route(async ({ actor }) => {
  if (actor.type !== "user") {
    throw new AuthError("MFA requires a user session");
  }

  const db = createAdminClient();
  const { data, error } = await db
    .from("user_mfa")
    .select("enabled")
    .eq("user_id", actor.id)
    .maybeSingle();

  if (error) throw error;

  return ok({ enabled: data?.enabled ?? false });
});

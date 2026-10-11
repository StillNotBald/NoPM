import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import { MFA_COOKIE_NAME } from "@/lib/auth/mfa";

export const runtime = "nodejs";

/**
 * POST /api/auth/signout — sign the current session out via the server
 * Supabase client (cookie-based). No auth guard — the user calling this may
 * already have an invalid token; we always attempt signOut and succeed.
 *
 * Also clears the R-91 `nopm_mfa` challenge cookie — it is signature-bound
 * to the uid, not the Supabase session, so it would otherwise survive a
 * sign-out and (harmlessly, since a fresh sign-in still needs a real
 * password) linger until its own expiry.
 */
export async function POST(): Promise<Response> {
  const supabase = await createClient();
  await supabase.auth.signOut();

  const store = await cookies();
  store.delete({ name: MFA_COOKIE_NAME, path: "/" });

  return NextResponse.json({ data: { ok: true } });
}

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { resolveClientMeta } from "@/lib/audit/channel";
import { NextResponse } from "next/server";
import { MFA_COOKIE_NAME } from "@/lib/auth/mfa";

export const runtime = "nodejs";

/**
 * POST /api/auth/signout — sign the current session out via the server
 * Supabase client (cookie-based). No auth guard — the user calling this may
 * already have an invalid token; we always attempt signOut and succeed.
 *
 * A3-13: when the caller still has a resolvable session, one `auth.signout`
 * audit row is written BEFORE the session is dropped. It is fail-soft: an
 * unresolvable session (expired / already signed out) writes nothing, and an
 * audit hiccup never blocks a sign-out. (Password sign-in itself happens in the
 * browser against Supabase Auth and never reaches this API, so a sign-in row
 * cannot be written here; failed MFA attempts are audited by the mfa routes.)
 *
 * Also clears the R-91 `nopm_mfa` challenge cookie — it is signature-bound
 * to the uid, not the Supabase session, so it would otherwise survive a
 * sign-out and (harmlessly, since a fresh sign-in still needs a real
 * password) linger until its own expiry.
 */
export async function POST(request?: Request): Promise<Response> {
  const supabase = await createClient();

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: profile } = await createAdminClient()
        .from("profiles")
        .select("workspace_id, email, display_name")
        .eq("id", user.id)
        .maybeSingle();
      if (profile) {
        const meta = request ? resolveClientMeta(request.headers, "user") : {};
        await writeAudit({
          workspaceId: profile.workspace_id,
          actor: {
            type: "user",
            id: user.id,
            label: profile.display_name || profile.email || user.email || user.id,
            workspaceId: profile.workspace_id,
            ...meta,
          },
          action: "auth.signout",
          targetType: "session",
          targetId: user.id,
          before: null,
          after: null,
        });
      }
    }
  } catch (error) {
    console.error("[nopm][signout] fail-soft audit write failed:", error);
  }

  await supabase.auth.signOut();

  const store = await cookies();
  store.delete({ name: MFA_COOKIE_NAME, path: "/" });

  return NextResponse.json({ data: { ok: true } });
}

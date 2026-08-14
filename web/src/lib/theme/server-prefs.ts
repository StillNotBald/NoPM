import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { DbAppearanceFields } from "@/lib/theme/appearance";

/**
 * Server-Component-only counterpart to GET /api/me/preferences (L-39
 * follow-through), used ONLY to resolve the density/dateDisplay override for
 * layout.tsx's before-first-paint SSR stamp (`mergeAppearanceWithDb`). NOT a
 * general-purpose preferences reader — the real read/write API is
 * GET/PUT /api/me/preferences; this exists because a Server Component has no
 * `Actor`/`route()` context to call through.
 *
 * Resolution mirrors guard.ts's verifySession() (that function isn't
 * exported — guard.ts is owned by another task in this wave, matching the
 * precedent set by lib/auth/demo.ts) rather than duplicating its full Actor
 * shape: get the session user via the RLS-respecting server client, read
 * that user's OWN profile row (workspace_id, email — profiles RLS allows
 * self-read, the same lookup verifySession() performs), then read
 * user_preferences via the ADMIN client filtered by (user_id, workspace_id)
 * — user_preferences itself is deny-all RLS (service-role only), so an RLS
 * client could never read it regardless of ownership.
 *
 * Demo detection is inlined (compare profile.email to DEMO_EMAIL) rather
 * than calling isDemoActor() — that function re-derives the same profile row
 * via a second admin-client query from an Actor we don't have here; we
 * already hold the email from the one RLS lookup this function needs anyway.
 *
 * Fails CLOSED to `null` (cookie-only) on every path — no session, no
 * profile, the demo account, or any Supabase error. A signed-in user's
 * appearance NEVER blocks page render; worst case they see their per-device
 * cookie value instead of their per-account DB value for one request.
 */
export async function readSignedInAppearanceOverride(): Promise<DbAppearanceFields | null> {
  try {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data: profile } = await supabase
      .from("profiles")
      .select("workspace_id, email")
      .eq("id", user.id)
      .maybeSingle();
    if (!profile) return null;

    const demoEmail = process.env.DEMO_EMAIL;
    if (demoEmail && profile.email === demoEmail) return null; // shared demo identity — cookie only

    const admin = createAdminClient();
    const { data: row } = await admin
      .from("user_preferences")
      .select("config")
      .eq("user_id", user.id)
      .eq("workspace_id", profile.workspace_id)
      .maybeSingle();

    return (row?.config as DbAppearanceFields | undefined) ?? null;
  } catch {
    // Any failure (network, auth, malformed row) degrades to cookie-only —
    // never breaks the page render.
    return null;
  }
}

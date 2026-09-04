import { cache } from "react";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { DbAppearanceFields } from "@/lib/theme/appearance";
import type { PreferencesConfig } from "@/app/api/me/preferences/_schema";

/**
 * Server-Component-only counterpart to GET /api/me/preferences (L-39
 * follow-through, extended R-78), used to resolve per-account preference
 * overrides for before-first-paint SSR (the appearance density/dateDisplay
 * stamp AND the console layout's initial nav mode). NOT a general-purpose
 * preferences reader — the real read/write API is GET/PUT
 * /api/me/preferences; this exists because a Server Component has no
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
 * Wrapped in React's `cache()` so root layout.tsx and the console layout —
 * both Server Components that run during the SAME request — share ONE DB
 * read instead of issuing it twice.
 *
 * Fails CLOSED on every path — no session, no profile, or any Supabase
 * error yields `{ config: null, hasRow: false, isDemo: false, signedIn:
 * false }`. A signed-in user's page NEVER blocks render on this; worst case
 * they see their per-device cookie value / the Essentials default instead
 * of their per-account DB value for one request.
 */
export interface SignedInPreferences {
  config: PreferencesConfig | null;
  /** True only when a user_preferences row exists for this account. */
  hasRow: boolean;
  /** True for the shared demo login. */
  isDemo: boolean;
  /** True when there is a resolved session at all (false for an anonymous visitor). */
  signedIn: boolean;
}

const EMPTY: SignedInPreferences = { config: null, hasRow: false, isDemo: false, signedIn: false };

export const readSignedInPreferences = cache(async (): Promise<SignedInPreferences> => {
  try {
    const supabase = await createServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return EMPTY;

    const { data: profile } = await supabase
      .from("profiles")
      .select("workspace_id, email")
      .eq("id", user.id)
      .maybeSingle();
    if (!profile) return EMPTY;

    const demoEmail = process.env.DEMO_EMAIL;
    const isDemo = Boolean(demoEmail && profile.email === demoEmail);
    if (isDemo) return { config: null, hasRow: false, isDemo: true, signedIn: true }; // shared demo identity — cookie only

    const admin = createAdminClient();
    const { data: row } = await admin
      .from("user_preferences")
      .select("config")
      .eq("user_id", user.id)
      .eq("workspace_id", profile.workspace_id)
      .maybeSingle();

    return {
      config: (row?.config as PreferencesConfig | undefined) ?? null,
      hasRow: Boolean(row),
      isDemo: false,
      signedIn: true,
    };
  } catch {
    // Any failure (network, auth, malformed row) degrades to signed-out
    // behaviour — never breaks the page render.
    return EMPTY;
  }
});

/**
 * L-39's original single-purpose reader, re-implemented on top of
 * `readSignedInPreferences` so root layout.tsx keeps working unchanged.
 * Result is identical to the pre-R-78 implementation: the config for a
 * signed-in non-demo user with a row, else null.
 */
export async function readSignedInAppearanceOverride(): Promise<DbAppearanceFields | null> {
  const { config, isDemo } = await readSignedInPreferences();
  if (isDemo) return null;
  return (config as DbAppearanceFields | null) ?? null;
}

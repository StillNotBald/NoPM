import { decodePreferencesConfig } from "@/app/api/me/preferences/_schema";
import { readSignedInPreferences } from "@/lib/theme/server-prefs";
import { pickOnboardingConfig, type PrefsSeed } from "./seed";

/**
 * Server Components only. The viewer's onboarding state as a `PrefsSeed`, or
 * null when the server cannot resolve it (no session, lookup failure), in which
 * case the surfaces fall back to waiting for the client store as before.
 *
 * Reuses `readSignedInPreferences`, which is React-cache()d: the root and
 * console layouts already made this read for the request, so this costs no
 * additional query. The shared demo login resolves to an empty config
 * (everything shown, nothing persisted), exactly what the GET returns for it.
 */
export async function readOnboardingSeed(): Promise<PrefsSeed | null> {
  const prefs = await readSignedInPreferences();
  if (!prefs.signedIn) return null;
  return {
    // decode: the stored jsonb is `unknown` until validated; a corrupt row
    // degrades to the empty config, never to a broken page
    config: pickOnboardingConfig(decodePreferencesConfig(prefs.config)),
    demo: prefs.isDemo,
  };
}

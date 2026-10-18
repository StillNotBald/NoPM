/**
 * Server-resolved onboarding state, so a client surface can render CORRECTLY
 * on the server instead of waiting for GET /api/me/preferences.
 *
 * The governance tour, the first-run wizard, the /start checklist and the page
 * hint used to render nothing until the preferences GET resolved (whether each
 * one is dismissed is a per-viewer preference). When the answer arrived the
 * card popped in and everything below it moved: CLS 0.19 on /dashboard and 0.16
 * on /start. The fix is at the source: the page reads the viewer's preferences
 * on the server (the same React-cached read the layouts already make, so no
 * extra query) and hands the relevant slice down as a `seed`; the first server
 * render and the first client render both come from it, so nothing moves when
 * the client store loads.
 *
 * Pure module (no React, no I/O): the server reader is `seed-server.ts`, the
 * client hook is `components/onboarding/use-seeded-preferences.ts`.
 */
import {
  mergePreferencesConfig,
  type PreferencesConfig,
} from "@/app/api/me/preferences/_schema";

/** The slice of the viewer's preferences the onboarding surfaces read. */
export type OnboardingConfig = Pick<PreferencesConfig, "onboarding" | "tour" | "start" | "hints">;

export interface PrefsSeed {
  config: OnboardingConfig;
  /**
   * The shared demo login never persists preferences (ADR 0009). The seed
   * carries it so a click made before the client store has loaded is kept
   * local instead of being PUT for the demo identity.
   */
  demo: boolean;
}

/** Keep only the onboarding keys (also keeps unrelated prefs out of the page payload). */
export function pickOnboardingConfig(config: PreferencesConfig | null | undefined): OnboardingConfig {
  const out: OnboardingConfig = {};
  if (config?.onboarding) out.onboarding = config.onboarding;
  if (config?.tour) out.tour = config.tour;
  if (config?.start) out.start = config.start;
  if (config?.hints) out.hints = config.hints;
  return out;
}

/**
 * The config a surface should render from right now.
 *
 *   store loaded  -> the store's config (the source of truth once it exists)
 *   store loading -> the server seed, if the server could resolve one
 *   neither       -> the store's (still empty) config; the surface keeps its
 *                    old "wait until ready" behaviour
 *
 * `local` holds this component's own actions (dismiss, mark visited) and always
 * wins: a click made while the store's GET was still in flight must not be
 * undone when that GET lands with the pre-click state.
 */
export function resolveSeededConfig(input: {
  seed: PrefsSeed | null | undefined;
  storeReady: boolean;
  storeConfig: PreferencesConfig;
  local: PreferencesConfig;
}): PreferencesConfig {
  const base = input.storeReady ? input.storeConfig : (input.seed?.config ?? input.storeConfig);
  return mergePreferencesConfig(base, input.local);
}

/** Whether a surface can render now: the store has loaded, or the server already knew. */
export function isSeededReady(input: { seed: PrefsSeed | null | undefined; storeReady: boolean }): boolean {
  return input.storeReady || !!input.seed;
}

/**
 * Whether an update should be sent to the server. Once the store has loaded it
 * decides for itself (it no-ops the PUT for the demo identity). Before that, the
 * seed's `demo` flag stands in so the shared demo login is never written to.
 */
export function shouldPersist(input: {
  seed: PrefsSeed | null | undefined;
  storeReady: boolean;
  storeDemo: boolean;
}): boolean {
  if (input.storeReady) return !input.storeDemo;
  return !input.seed?.demo;
}

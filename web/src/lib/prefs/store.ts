import { apiGet, apiPut } from "@/lib/api-client";
import {
  mergePreferencesConfig,
  type PreferencesConfig,
} from "@/app/api/me/preferences/_schema";

/**
 * Client-side preferences store (R-78, sprint 2026-09-04) — ONE cached
 * GET /api/me/preferences per browser session, shared by every consumer.
 *
 * Why: before this store each consumer (first-run wizard, governance tour,
 * every `useDateDisplayPref` date surface, register column/group-by hooks,
 * the settings page) issued its own GET on mount, so a single console page
 * could fire 3–6 identical preference reads — each one costing an auth
 * resolution, a demo-identity lookup, a rate-limit RPC and the row read.
 * ClickUp's #2 complaint is speed; this is the cheapest per-page win.
 *
 * Contract:
 *   - `loadPreferences()` dedupes concurrent callers and caches the first
 *     successful snapshot for the life of the page (module state).
 *   - `updatePreferences(partial)` merges locally FIRST (optimistic, same
 *     semantics as the server's merge-upsert — see mergePreferencesConfig),
 *     notifies subscribers, then PUTs the partial. For the shared demo
 *     identity (`demo: true`) it never PUTs — local only, fresh per visit
 *     (the shared-demo-identity carve-out, ADR 0009).
 *   - Top-level keys other than `columns`/`groupBy` are REPLACED whole by a
 *     partial, so callers must send the complete object for the key they
 *     own (e.g. the full `hints.dismissed` array), computed from the
 *     current snapshot.
 *   - Pure module (no React). `use-preferences.ts` wraps it in a hook via
 *     useSyncExternalStore. Tests reset it with `resetPreferencesStore()`.
 *   - Fail-soft everywhere: a failed GET yields `status: "error"` with an
 *     empty config (consumers fall back to their defaults); a failed PUT
 *     keeps the optimistic local state and logs once.
 */

export type PrefsStatus = "idle" | "loading" | "ready" | "error";

export interface PrefsSnapshot {
  status: PrefsStatus;
  config: PreferencesConfig;
  /** true for the shared demo login — never persist to the DB for it. */
  demo: boolean;
  /** null when the user has no user_preferences row yet (brand-new account). */
  updatedAt: string | null;
}

interface PreferencesGetResponse {
  config?: PreferencesConfig;
  demo?: boolean;
  updatedAt?: string | null;
}

const INITIAL: PrefsSnapshot = { status: "idle", config: {}, demo: false, updatedAt: null };

let snapshot: PrefsSnapshot = INITIAL;
let inflight: Promise<PrefsSnapshot> | null = null;
const listeners = new Set<() => void>();

function emit(next: PrefsSnapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

/** Current snapshot (stable reference until the next change — safe for useSyncExternalStore). */
export function getPrefsSnapshot(): PrefsSnapshot {
  return snapshot;
}

export function subscribePreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Load once. Repeat calls while loading share the same promise; calls after
 * a successful load resolve immediately from cache. A failed load is NOT
 * cached — the next call retries (so a transient 401 during sign-in doesn't
 * poison the whole session).
 */
export function loadPreferences(): Promise<PrefsSnapshot> {
  if (snapshot.status === "ready") return Promise.resolve(snapshot);
  if (inflight) return inflight;
  emit({ ...snapshot, status: "loading" });
  inflight = apiGet<PreferencesGetResponse>("/api/me/preferences")
    .then((res) => {
      const next: PrefsSnapshot = {
        status: "ready",
        config: res?.config ?? {},
        demo: Boolean(res?.demo),
        updatedAt: res?.updatedAt ?? null,
      };
      emit(next);
      return next;
    })
    .catch(() => {
      const next: PrefsSnapshot = { ...snapshot, status: "error" };
      emit(next);
      return next;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Optimistic local merge + fail-soft PUT of the partial. Resolves once the
 * local state is updated (NOT once the PUT completes) so UI never waits on
 * the network for a display preference.
 */
export function updatePreferences(partial: PreferencesConfig): Promise<void> {
  const merged = mergePreferencesConfig(snapshot.config, partial);
  emit({ ...snapshot, config: merged });
  if (snapshot.demo) return Promise.resolve();
  void apiPut("/api/me/preferences", { config: partial }).catch((err: unknown) => {
    // Display preference only — never governance data; keep the optimistic
    // state and say so once rather than throwing into a render path.
    console.warn("[prefs] PUT /api/me/preferences failed (kept local state)", err);
  });
  return Promise.resolve();
}

/** Test/sign-out hook — drop the cache so the next load refetches. */
export function resetPreferencesStore(): void {
  snapshot = INITIAL;
  inflight = null;
  listeners.clear();
}

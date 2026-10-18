"use client";

import { useCallback, useState } from "react";
import { usePreferences } from "@/lib/prefs/use-preferences";
import {
  mergePreferencesConfig,
  type PreferencesConfig,
} from "@/app/api/me/preferences/_schema";
import {
  isSeededReady,
  resolveSeededConfig,
  shouldPersist,
  type PrefsSeed,
} from "@/lib/onboarding/seed";

/**
 * `usePreferences()` for the onboarding surfaces, rendering from a
 * server-resolved `seed` until the client store has loaded (see
 * lib/onboarding/seed.ts for why). Same shape as the store hook, so a surface
 * only swaps the hook:
 *
 *   const { ready, config, update } = useSeededPreferences(seed);
 *
 * - First server render and first client render both use `seed`, so hydration
 *   matches and nothing moves when the store's GET lands.
 * - `update` records the change locally first (it wins over whatever the store
 *   later loads) and forwards it to the store, except for the demo identity
 *   before the store knows it is the demo identity.
 */
export function useSeededPreferences(seed?: PrefsSeed | null) {
  const store = usePreferences();
  const [local, setLocal] = useState<PreferencesConfig>({});

  const config = resolveSeededConfig({
    seed,
    storeReady: store.ready,
    storeConfig: store.config,
    local,
  });
  const ready = isSeededReady({ seed, storeReady: store.ready });

  const { update: storeUpdate } = store;
  const storeReady = store.ready;
  const storeDemo = store.demo;
  const update = useCallback(
    (partial: PreferencesConfig) => {
      setLocal((cur) => mergePreferencesConfig(cur, partial));
      if (shouldPersist({ seed, storeReady, storeDemo })) void storeUpdate(partial);
    },
    [seed, storeReady, storeDemo, storeUpdate],
  );

  return { ready, config, update };
}

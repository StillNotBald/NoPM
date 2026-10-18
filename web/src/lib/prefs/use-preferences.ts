"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  getPrefsSnapshot,
  loadPreferences,
  subscribePreferences,
  updatePreferences,
  type PrefsSnapshot,
} from "./store";

const SERVER_SNAPSHOT: PrefsSnapshot = { status: "idle", config: {}, demo: false, updatedAt: null };

/**
 * React binding for lib/prefs/store.ts. The first render (server + client
 * hydration) always sees the idle/empty snapshot so there is no hydration
 * mismatch; the shared load kicks off once after mount and every subscriber
 * re-renders together when it lands.
 *
 * `ready` is true once a GET has resolved (successfully or not) — consumers
 * that must not flash a default should render nothing until then, exactly
 * as the wizard/tour already did with their own per-component fetch.
 */
export function usePreferences() {
  const snapshot = useSyncExternalStore(
    subscribePreferences,
    getPrefsSnapshot,
    () => SERVER_SNAPSHOT,
  );

  useEffect(() => {
    void loadPreferences();
  }, []);

  return {
    ...snapshot,
    ready: snapshot.status === "ready" || snapshot.status === "error",
    update: updatePreferences,
  };
}

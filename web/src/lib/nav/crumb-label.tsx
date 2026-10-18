"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * Tiny route-entity label registry for breadcrumbs. A server page that
 * already holds the entity (e.g. the project detail page) renders
 * `<CrumbLabel id=… label=… />`; the breadcrumb bar reads it back via
 * `useCrumbLabel(id)`. Replaces the old "fetch the whole /api/projects list
 * just to find one name" lookup. No fetch, no raw-UUID fallback.
 */
const labels = new Map<string, string>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setCrumbLabel(id: string, label: string) {
  if (labels.get(id) === label) return;
  labels.set(id, label);
  emit();
}

export function useCrumbLabel(id: string | null): string | null {
  return useSyncExternalStore(
    subscribe,
    () => (id ? (labels.get(id) ?? null) : null),
    () => null,
  );
}

/** Renders nothing; registers `label` as the breadcrumb text for `id`. */
export function CrumbLabel({ id, label }: { id: string; label: string }) {
  useEffect(() => {
    setCrumbLabel(id, label);
  }, [id, label]);
  return null;
}

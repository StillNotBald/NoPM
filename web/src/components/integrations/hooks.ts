"use client";

/**
 * Small client hooks for the Integrations console.
 *
 * `useApiResource` is the page's one data-loading pattern: load on mount,
 * `reload()` to refresh in place (stale data stays on screen — no spinner
 * flash after a mutation), `retry()` to start over from the loading state.
 * Failures are classified (404 -> unavailable, 403 -> forbidden) so cards can
 * render calm copy instead of a raw error.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { classifyError, type ErrorKind } from "./model";

export type ResourceState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "unavailable"; message: string }
  | { status: "forbidden"; message: string }
  | { status: "error"; message: string };

export function useApiResource<T>(fetcher: () => Promise<T>): {
  state: ResourceState<T>;
  reload: () => void;
  retry: () => void;
} {
  const [state, setState] = useState<ResourceState<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetcher().then(
      (data) => {
        if (!cancelled) setState({ status: "ready", data });
      },
      (e: unknown) => {
        if (cancelled) return;
        const { kind, message }: { kind: ErrorKind; message: string } = classifyError(e);
        setState({ status: kind, message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [fetcher, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setNonce((n) => n + 1);
  }, []);

  return { state, reload, retry };
}

/**
 * `Date.now()` as state, ticking every `intervalMs` while `active` — keeps
 * render pure. Re-syncs immediately when it becomes active, so a countdown
 * that starts long after mount never shows a stale first frame.
 */
export function useNow(active = true, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const first = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [active, intervalMs]);
  return now;
}

const noopSubscribe = () => () => {};

/** `window.location.origin` without a hydration mismatch ("" during SSR). */
export function useOrigin(): string {
  return useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => "",
  );
}

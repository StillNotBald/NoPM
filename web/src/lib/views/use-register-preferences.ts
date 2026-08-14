"use client";

/**
 * L-39 follow-through — wires a register's column-chooser (L-11) and
 * group-by (L-09) selection into the SAME per-user DB store appearance
 * prefs use (GET/PUT /api/me/preferences), for a signed-in NON-demo user.
 *
 * Deliberately NOT added to ./view-config.ts: that file is the pure
 * `saved_views.config` codec (URL <-> jsonb) — a different store, a
 * different shape (register-agnostic filters+sort+columns+groupBy owned by
 * one saved view), and a different task's file (W2). This is a sibling file
 * in the same `lib/views/` directory so the two preference stores a register
 * page might read from (a saved view vs. this personal default) stay
 * co-located and easy to find together, without either task editing the
 * other's file. A register page's existing "columns → localStorage when no
 * saved view is active" behavior (see e.g. `(console)/tasks/page.tsx`) is
 * left completely in place as the fallback for anonymous/demo/pre-hydration
 * — this hook is an ADDITIVE upgrade: when it resolves with a value, the
 * caller prefers it; until then, or if it never resolves, localStorage/the
 * component default keeps working exactly as before.
 *
 * Persistence is fire-and-forget and best-effort by design — same posture
 * as the appearance section's PUT (web/src/app/(console)/settings/page.tsx):
 * a failed write here never blocks the (already-applied) local UI state,
 * and this hook is per-user DISPLAY state, never governance data (ADR 0009).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPut } from "@/lib/api-client";
import type { PreferencesConfig } from "@/app/api/me/preferences/_schema";

// ── Pure config-patch helpers (unit-testable without mounting anything) ───

/** Sets `config.columns[register]`, leaving every other register/key untouched. */
export function patchConfigColumns(
  config: PreferencesConfig,
  register: string,
  columns: string[],
): PreferencesConfig {
  return { ...config, columns: { ...(config.columns ?? {}), [register]: columns } };
}

/** Sets `config.groupBy[register]`, leaving every other register/key untouched. */
export function patchConfigGroupBy(
  config: PreferencesConfig,
  register: string,
  groupBy: string | null,
): PreferencesConfig {
  return { ...config, groupBy: { ...(config.groupBy ?? {}), [register]: groupBy } };
}

// ── The hook ─────────────────────────────────────────────────────────────

export interface RegisterPreferences {
  /** True once the initial GET has settled (success OR failure) — the point at which the caller may trust `columns`/`groupBy` as "DB says nothing" vs. "still loading". */
  ready: boolean;
  /** True for the shared demo identity — informational; setColumns/setGroupBy already no-op for demo on their own. */
  demo: boolean;
  /** This register's DB-stored column list, or null if unset/unavailable. */
  columns: string[] | null;
  /** This register's DB-stored group-by field, or null if unset/unavailable. */
  groupBy: string | null;
  /** Fire-and-forget PUT — merges into the existing config, never clobbers other registers. No-op for demo/anonymous/token callers. */
  setColumns: (columns: string[]) => void;
  /** Fire-and-forget PUT — merges into the existing config, never clobbers other registers. No-op for demo/anonymous/token callers. */
  setGroupBy: (groupBy: string | null) => void;
}

export function useRegisterPreferences(register: string): RegisterPreferences {
  const [ready, setReady] = useState(false);
  const [demo, setDemo] = useState(false);
  const [columns, setColumnsState] = useState<string[] | null>(null);
  const [groupBy, setGroupByState] = useState<string | null>(null);
  const configRef = useRef<PreferencesConfig>({});
  const canWriteRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<{ config?: PreferencesConfig; demo?: boolean }>("/api/me/preferences")
      .then((data) => {
        if (cancelled || !data) return;
        const config = data.config ?? {};
        configRef.current = config;
        const isDemo = Boolean(data.demo);
        canWriteRef.current = !isDemo;
        setDemo(isDemo);
        setColumnsState(config.columns?.[register] ?? null);
        setGroupByState(config.groupBy?.[register] ?? null);
      })
      .catch(() => {
        // Anonymous / token caller / offline — ready still flips below so
        // the caller stops waiting and falls back to its own default.
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [register]);

  const setColumns = useCallback(
    (next: string[]) => {
      if (!canWriteRef.current) return;
      const nextConfig = patchConfigColumns(configRef.current, register, next);
      configRef.current = nextConfig;
      apiPut("/api/me/preferences", { config: nextConfig }).catch(() => {});
    },
    [register],
  );

  const setGroupBy = useCallback(
    (next: string | null) => {
      if (!canWriteRef.current) return;
      const nextConfig = patchConfigGroupBy(configRef.current, register, next);
      configRef.current = nextConfig;
      apiPut("/api/me/preferences", { config: nextConfig }).catch(() => {});
    },
    [register],
  );

  return { ready, demo, columns, groupBy, setColumns, setGroupBy };
}

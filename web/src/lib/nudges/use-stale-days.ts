"use client";

import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api-client";
import { STALE_STATUS_AGE_DAYS } from "@/lib/insight/status-age";

/**
 * The workspace's "stale after N days" setting for client components (the
 * kanban card flag). One fetch per page load, shared; starts at the default
 * and never throws, so a failed read leaves the flag at 14 days.
 */
let cached: number | null = null;
let inflight: Promise<number> | null = null;

function load(): Promise<number> {
  if (cached !== null) return Promise.resolve(cached);
  inflight ??= apiGet<{ stale_days?: number } | null>("/api/workspace-settings")
    .then((raw) => {
      const v = raw?.stale_days;
      cached = typeof v === "number" && v >= 1 && v <= 365 ? v : STALE_STATUS_AGE_DAYS;
      return cached;
    })
    .catch(() => STALE_STATUS_AGE_DAYS)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useStaleDays(): number {
  const [days, setDays] = useState<number>(cached ?? STALE_STATUS_AGE_DAYS);
  useEffect(() => {
    let live = true;
    void load().then((v) => {
      if (live) setDays(v);
    });
    return () => {
      live = false;
    };
  }, []);
  return days;
}

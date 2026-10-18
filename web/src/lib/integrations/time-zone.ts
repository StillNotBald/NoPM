/**
 * Workspace time zone (Q-ACC-18 / Q-WRK-23, decisions 2026-10-17).
 *
 * `workspaces.time_zone` is an IANA zone name, default Asia/Kuala_Lumpur. It
 * decides (a) which calendar day "today" is for server-side defaults and (b)
 * which weekday the weekly digest goes out on. Everything here is pure and
 * takes the zone as an argument; `getWorkspaceTimeZone` is the one DB read.
 *
 * "Shifted" dates: `shiftToZone(d, tz)` returns a Date whose UTC fields equal
 * the wall-clock fields of `d` in `tz`, so the existing UTC-based week maths
 * can run unchanged on workspace-local time.
 */
import { createAdminClient } from "@/lib/supabase/admin";

export const DEFAULT_TIME_ZONE = "Asia/Kuala_Lumpur";

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Valid zone or the default (a bad stored value must never break a digest). */
export function resolveTimeZone(tz: unknown): string {
  return isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
}

function parts(d: Date, tz: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(d)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

/** A Date whose UTC fields are `d`'s wall-clock fields in `tz`. */
export function shiftToZone(d: Date, tz: string): Date {
  const p = parts(d, resolveTimeZone(tz));
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, d.getUTCMilliseconds()));
}

/** YYYY-MM-DD of `now` in the zone. */
export function todayInZone(tz: string, now: Date = new Date()): string {
  return shiftToZone(now, tz).toISOString().slice(0, 10);
}

/** The workspace's zone (default when unset, invalid or unreadable). */
export async function getWorkspaceTimeZone(workspaceId: string): Promise<string> {
  try {
    const { data, error } = await createAdminClient()
      .from("workspaces")
      .select("time_zone")
      .eq("id", workspaceId)
      .maybeSingle();
    if (error) throw error;
    return resolveTimeZone((data as { time_zone?: unknown } | null)?.time_zone);
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** Convenience for route handlers: today's date in the workspace zone. */
export async function workspaceToday(workspaceId: string, now: Date = new Date()): Promise<string> {
  return todayInZone(await getWorkspaceTimeZone(workspaceId), now);
}

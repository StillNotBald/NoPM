import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Workspace nudge + weekly-report settings (R-141 / R-142, migration 0096).
 * Pure resolve/validate helpers plus one fail-soft read. A workspace on a
 * database that has not applied 0096 yet (the columns are missing) simply gets
 * the defaults, so the app can deploy before the migration without breaking.
 */

export const DEFAULT_STALE_DAYS = 14;
export const MIN_STALE_DAYS = 1;
export const MAX_STALE_DAYS = 365;

export type NudgeSettings = {
  stale_days: number;
  nudges_enabled: boolean;
  weekly_report_enabled: boolean;
  /** ISO weekday in the workspace time zone: 1 = Monday ... 7 = Sunday. */
  weekly_report_day: number;
};

export const DEFAULT_NUDGE_SETTINGS: NudgeSettings = {
  stale_days: DEFAULT_STALE_DAYS,
  nudges_enabled: true,
  weekly_report_enabled: true,
  weekly_report_day: 1,
};

export const NUDGE_SETTING_COLUMNS = "stale_days, nudges_enabled, weekly_report_enabled, weekly_report_day";

export function isValidStaleDays(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_STALE_DAYS && v <= MAX_STALE_DAYS;
}

export function isValidReportDay(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 7;
}

/** A stored row (or null / partial) to complete settings; bad values fall back to the default. */
export function resolveNudgeSettings(raw: unknown): NudgeSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    stale_days: isValidStaleDays(r.stale_days) ? r.stale_days : DEFAULT_NUDGE_SETTINGS.stale_days,
    nudges_enabled: typeof r.nudges_enabled === "boolean" ? r.nudges_enabled : DEFAULT_NUDGE_SETTINGS.nudges_enabled,
    weekly_report_enabled:
      typeof r.weekly_report_enabled === "boolean"
        ? r.weekly_report_enabled
        : DEFAULT_NUDGE_SETTINGS.weekly_report_enabled,
    weekly_report_day: isValidReportDay(r.weekly_report_day)
      ? r.weekly_report_day
      : DEFAULT_NUDGE_SETTINGS.weekly_report_day,
  };
}

/** The workspace's settings (defaults when unreadable or the migration is not applied). */
export async function getNudgeSettings(workspaceId: string): Promise<NudgeSettings> {
  try {
    const { data, error } = await createAdminClient()
      .from("workspaces")
      .select(NUDGE_SETTING_COLUMNS)
      .eq("id", workspaceId)
      .maybeSingle();
    if (error) throw error;
    return resolveNudgeSettings(data);
  } catch {
    return { ...DEFAULT_NUDGE_SETTINGS };
  }
}

/** Just the stale threshold, for callers that only need the number (digest, kanban). */
export async function getStaleDays(workspaceId: string): Promise<number> {
  return (await getNudgeSettings(workspaceId)).stale_days;
}

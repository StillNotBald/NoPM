import { route } from "@/lib/api/handler";
import { ScopeError } from "@/lib/api/errors";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { writeAudit } from "@/lib/audit/write";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_TIME_ZONE, isValidTimeZone, resolveTimeZone } from "@/lib/integrations/time-zone";
import {
  MAX_STALE_DAYS,
  MIN_STALE_DAYS,
  NUDGE_SETTING_COLUMNS,
  isValidReportDay,
  isValidStaleDays,
  resolveNudgeSettings,
} from "@/lib/nudges/settings";

export const runtime = "nodejs";

/**
 * GET/PATCH /api/workspace-settings (Q-ACC-18 / Q-WRK-23, R-141 / R-142).
 *
 * Workspace-wide settings an admin owns:
 *  - `time_zone`: an IANA zone name (default Asia/Kuala_Lumpur) that sets the
 *    weekly-digest weekday and the server-side "today" defaults.
 *  - `stale_days` (1-365, default 14): days without an update before a task,
 *    risk or issue counts as stale (kanban flag, nudges, digest line).
 *  - `nudges_enabled`: the daily stale-item notifications.
 *  - `weekly_report_enabled` / `weekly_report_day` (ISO weekday 1-7, Monday = 1,
 *    in the workspace time zone): the weekly status report.
 * GET is open to any signed-in member or token; PATCH is admin sessions only,
 * takes any subset of the fields, and writes exactly one audit row
 * (`workspace.settings_update`) holding only the fields that changed.
 *
 * To add a setting, add one entry to FIELDS (validator + reader) and to GET.
 */

type FieldSpec = { valid: (v: unknown) => boolean; message: string; read: (stored: Record<string, unknown>) => unknown };

const FIELDS: Record<string, FieldSpec> = {
  time_zone: {
    valid: isValidTimeZone,
    message: "Use an IANA time zone name such as Asia/Kuala_Lumpur.",
    read: (s) => resolveTimeZone(s.time_zone),
  },
  stale_days: {
    valid: isValidStaleDays,
    message: `Use a whole number of days from ${MIN_STALE_DAYS} to ${MAX_STALE_DAYS}.`,
    read: (s) => resolveNudgeSettings(s).stale_days,
  },
  nudges_enabled: {
    valid: (v) => typeof v === "boolean",
    message: "Use true or false.",
    read: (s) => resolveNudgeSettings(s).nudges_enabled,
  },
  weekly_report_enabled: {
    valid: (v) => typeof v === "boolean",
    message: "Use true or false.",
    read: (s) => resolveNudgeSettings(s).weekly_report_enabled,
  },
  weekly_report_day: {
    valid: isValidReportDay,
    message: "Use a weekday number from 1 (Monday) to 7 (Sunday).",
    read: (s) => resolveNudgeSettings(s).weekly_report_day,
  },
};

const SELECT = `time_zone, ${NUDGE_SETTING_COLUMNS}`;

function view(stored: Record<string, unknown> | null) {
  const s = stored ?? {};
  return {
    time_zone: resolveTimeZone(s.time_zone),
    default_time_zone: DEFAULT_TIME_ZONE,
    ...resolveNudgeSettings(s),
  };
}

export const GET = route(async ({ actor }) => {
  const db = createAdminClient();
  // A database without migration 0096 rejects the new columns: fall back to the zone alone.
  let res = await db.from("workspaces").select(SELECT).eq("id", actor.workspaceId).maybeSingle();
  if (res.error) res = await db.from("workspaces").select("time_zone").eq("id", actor.workspaceId).maybeSingle();
  if (res.error) throw res.error;
  return ok(view(res.data as Record<string, unknown> | null));
});

export const PATCH = route(async ({ actor, request }) => {
  if (actor.type !== "user" || actor.role !== "admin") {
    throw new ScopeError("Changing workspace settings requires an admin session");
  }
  const body = (await safeJson<Record<string, unknown>>(request)) ?? {};

  const requested = Object.keys(FIELDS).filter((k) => k in body);
  if (requested.length === 0) {
    return validationError("Validation failed", [
      { field: "settings", message: `Send at least one of: ${Object.keys(FIELDS).join(", ")}.` },
    ]);
  }
  const bad = requested.filter((k) => !FIELDS[k].valid(body[k]));
  if (bad.length > 0) {
    return validationError("Validation failed", bad.map((k) => ({ field: k, message: FIELDS[k].message })));
  }

  const db = createAdminClient();
  let read = await db.from("workspaces").select(SELECT).eq("id", actor.workspaceId).maybeSingle();
  // Not migrated yet (0096): only the zone can be read, and only the zone can be saved.
  if (read.error) read = await db.from("workspaces").select("time_zone").eq("id", actor.workspaceId).maybeSingle();
  if (read.error) throw read.error;
  const before = read.data;
  const stored = (before ?? {}) as Record<string, unknown>;

  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  for (const k of requested) {
    const previous = FIELDS[k].read(stored);
    if (previous !== body[k]) {
      changedBefore[k] = previous;
      changedAfter[k] = body[k];
    }
  }

  if (Object.keys(changedAfter).length > 0) {
    const { error } = await db.from("workspaces").update(changedAfter).eq("id", actor.workspaceId);
    if (error) throw error;
    await writeAudit({
      workspaceId: actor.workspaceId,
      actor,
      action: "workspace.settings_update",
      targetType: "workspace",
      targetId: actor.workspaceId,
      before: changedBefore,
      after: changedAfter,
    });
  }
  return ok(view({ ...stored, ...changedAfter }));
});

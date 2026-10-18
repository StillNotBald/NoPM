import { route } from "@/lib/api/handler";
import { ScopeError } from "@/lib/api/errors";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { writeAudit } from "@/lib/audit/write";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_TIME_ZONE, isValidTimeZone, resolveTimeZone } from "@/lib/integrations/time-zone";

export const runtime = "nodejs";

/**
 * GET/PATCH /api/workspace-settings (Q-ACC-18 / Q-WRK-23).
 *
 * Workspace-wide settings an admin owns. Today: `time_zone`, an IANA zone name
 * (default Asia/Kuala_Lumpur) that sets the weekly-digest weekday and the
 * server-side "today" defaults. GET is open to any signed-in member or token;
 * PATCH is admin sessions only and writes exactly one audit row
 * (`workspace.settings_update`).
 */

export const GET = route(async ({ actor }) => {
  const db = createAdminClient();
  const { data, error } = await db.from("workspaces").select("time_zone").eq("id", actor.workspaceId).maybeSingle();
  if (error) throw error;
  return ok({
    time_zone: resolveTimeZone((data as { time_zone?: unknown } | null)?.time_zone),
    default_time_zone: DEFAULT_TIME_ZONE,
  });
});

export const PATCH = route(async ({ actor, request }) => {
  if (actor.type !== "user" || actor.role !== "admin") {
    throw new ScopeError("Changing workspace settings requires an admin session");
  }
  const body = await safeJson<{ time_zone?: unknown }>(request);
  const tz = body?.time_zone;
  if (!isValidTimeZone(tz)) {
    return validationError("Validation failed", [
      { field: "time_zone", message: "Use an IANA time zone name such as Asia/Kuala_Lumpur." },
    ]);
  }

  const db = createAdminClient();
  const { data: before, error: readError } = await db
    .from("workspaces")
    .select("time_zone")
    .eq("id", actor.workspaceId)
    .maybeSingle();
  if (readError) throw readError;
  const previous = resolveTimeZone((before as { time_zone?: unknown } | null)?.time_zone);

  if (previous !== tz) {
    const { error } = await db.from("workspaces").update({ time_zone: tz }).eq("id", actor.workspaceId);
    if (error) throw error;
    await writeAudit({
      workspaceId: actor.workspaceId,
      actor,
      action: "workspace.settings_update",
      targetType: "workspace",
      targetId: actor.workspaceId,
      before: { time_zone: previous },
      after: { time_zone: tz },
    });
  }
  return ok({ time_zone: tz, default_time_zone: DEFAULT_TIME_ZONE });
});

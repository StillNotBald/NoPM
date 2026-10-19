import { route } from "@/lib/api/handler";
import { ScopeError } from "@/lib/api/errors";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { buildAuditArg, mapAuditedError } from "@/lib/audit/audited-write";
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
import { mergePolicy, policyOf, validatePolicyInput } from "@/lib/governance/tiers";

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
 *  - `approval_policy` (G1/G3/G4/G7, migration 0100): the five approval tiers (approver role, turnaround
 *    hours, auto-approve for routine only), the currency threshold, its currency. (emergency_retro_hours is retired (D17): accepted, ignored and
 *    never stored; an emergency change owes no retro decision.) GET returns the policy with every default filled in. PATCH takes any subset of it (only the
 *    rules sent change), validates it, stores the complete result and records it in the audit row. Auto-approve
 *    is OFF unless an admin switches it on here.
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
const SELECT_WITH_POLICY = `${SELECT}, approval_policy`;

/** Read the settings row, degrading for a database that has not applied 0100 / 0096 yet. */
async function readWorkspace(db: ReturnType<typeof createAdminClient>, workspaceId: string) {
  let res = await db.from("workspaces").select(SELECT_WITH_POLICY).eq("id", workspaceId).maybeSingle();
  if (res.error) res = await db.from("workspaces").select(SELECT).eq("id", workspaceId).maybeSingle();
  // Not migrated yet (0096): only the zone can be read, and only the zone can be saved.
  if (res.error) res = await db.from("workspaces").select("time_zone").eq("id", workspaceId).maybeSingle();
  if (res.error) throw res.error;
  return res.data as Record<string, unknown> | null;
}

function view(stored: Record<string, unknown> | null) {
  const s = stored ?? {};
  return {
    time_zone: resolveTimeZone(s.time_zone),
    default_time_zone: DEFAULT_TIME_ZONE,
    ...resolveNudgeSettings(s),
    approval_policy: policyOf(s.approval_policy),
  };
}

export const GET = route(async ({ actor }) => {
  const db = createAdminClient();
  return ok(view(await readWorkspace(db, actor.workspaceId)));
});

export const PATCH = route(async ({ actor, request }) => {
  if (actor.type !== "user" || actor.role !== "admin") {
    throw new ScopeError("Changing workspace settings requires an admin session");
  }
  const body = (await safeJson<Record<string, unknown>>(request)) ?? {};

  const requested = Object.keys(FIELDS).filter((k) => k in body);
  const wantsPolicy = "approval_policy" in body;
  if (requested.length === 0 && !wantsPolicy) {
    return validationError("Validation failed", [
      { field: "settings", message: `Send at least one of: ${[...Object.keys(FIELDS), "approval_policy"].join(", ")}.` },
    ]);
  }
  const policyCheck = wantsPolicy ? validatePolicyInput(body.approval_policy) : null;
  if (policyCheck && !policyCheck.ok) {
    return validationError("Validation failed", policyCheck.issues);
  }
  const bad = requested.filter((k) => !FIELDS[k].valid(body[k]));
  if (bad.length > 0) {
    return validationError("Validation failed", bad.map((k) => ({ field: k, message: FIELDS[k].message })));
  }

  const db = createAdminClient();
  const stored = (await readWorkspace(db, actor.workspaceId)) ?? {};

  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  for (const k of requested) {
    const previous = FIELDS[k].read(stored);
    if (previous !== body[k]) {
      changedBefore[k] = previous;
      changedAfter[k] = body[k];
    }
  }

  // The approval policy: merge what was sent onto what is stored, store the complete normalised result.
  if (policyCheck && policyCheck.ok) {
    const previous = policyOf(stored.approval_policy);
    const merged = mergePolicy(stored.approval_policy, policyCheck.value, body.approval_policy);
    if (JSON.stringify(previous) !== JSON.stringify(merged)) {
      changedBefore.approval_policy = previous;
      changedAfter.approval_policy = merged;
    }
  }

  if (Object.keys(changedAfter).length > 0) {
    // The write and its audit row are ONE transaction (nopm_update_workspace_settings, migration 0101), and the
    // columns this admin read are pinned: if another admin saved the same setting meanwhile it is a 412, not a
    // silent overwrite.
    const expected: Record<string, unknown> = {};
    for (const k of Object.keys(changedAfter)) if (k in stored) expected[k] = stored[k] ?? null;
    const { error } = await db.rpc("nopm_update_workspace_settings", {
      p_workspace_id: actor.workspaceId,
      p_patch: changedAfter,
      p_expected: expected,
      p_audit: buildAuditArg(actor, actor.workspaceId, "workspace.settings_update", "workspace", {
        auditBefore: changedBefore,
        auditAfter: changedAfter,
      }),
    });
    if (error) mapAuditedError(error, "Workspace not found");
  }
  return ok(view({ ...stored, ...changedAfter }));
});

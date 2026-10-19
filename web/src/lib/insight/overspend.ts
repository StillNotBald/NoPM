import type { createAdminClient } from "@/lib/supabase/admin";
import type { Actor } from "@/lib/auth/guard";
import { buildRpcAudit } from "@/lib/audit/sql-audit-insert";

/** Decision 19 (Q-WRK-7): warn at 90% of plan by default, over at 100%. Never blocks. */
export const DEFAULT_WARN_PCT = 90;
export const OVER_PCT = 100;

export type OverspendLevel = "ok" | "warn" | "over";

export const OVERSPEND_AUDIT_ACTION = "budget.overspend";

/** Pure: which level does this spend sit at? No plan (planned <= 0) never warns. */
export function overspendLevel(
  planned: number,
  actual: number,
  warnPct: number = DEFAULT_WARN_PCT,
): OverspendLevel {
  if (!(planned > 0)) return "ok";
  const pct = (actual / planned) * 100;
  if (pct >= OVER_PCT) return "over";
  if (pct >= warnPct) return "warn";
  return "ok";
}

type Db = ReturnType<typeof createAdminClient>;

/**
 * Re-evaluate a project's spend against its plan and, when the level changed
 * since the last report, remember it and write ONE audit row for the crossing.
 * Best effort by design: overspend NEVER blocks the expense or budget change
 * that triggered it, so any failure is logged and swallowed.
 */
export async function recordOverspendCrossing(
  db: Db,
  actor: Actor,
  projectId: string,
): Promise<OverspendLevel | null> {
  try {
    const { data: budget } = await db
      .from("project_budget")
      .select("planned_amount, overspend_level, overspend_warn_pct")
      .eq("project_id", projectId)
      .eq("workspace_id", actor.workspaceId)
      .maybeSingle();
    if (!budget) return null;

    const { data: exp } = await db
      .from("expenses")
      .select("amount")
      .eq("project_id", projectId)
      .eq("workspace_id", actor.workspaceId);
    const actual = (exp ?? []).reduce(
      (s: number, r: { amount: number | null }) => s + (Number(r.amount) || 0),
      0,
    );
    const planned = Number(budget.planned_amount) || 0;
    const warnPct = Number(budget.overspend_warn_pct) || DEFAULT_WARN_PCT;
    const next = overspendLevel(planned, actual, warnPct);
    const previous = (budget.overspend_level as OverspendLevel | null) ?? "ok";
    if (next === previous) return next;

    // One database call (R-165): compare-and-set the level on the previous value, so two concurrent
    // expenses cannot both claim the crossing, and write the crossing's audit row in the same transaction.
    // If the audit row cannot be written the marker change rolls back with it, so the next check reports
    // the crossing instead of losing it. A lost compare-and-set writes nothing.
    const { error } = await db.rpc("nopm_overspend_cross", {
      p_workspace_id: actor.workspaceId,
      p_project_id: projectId,
      p_previous: previous,
      p_next: next,
      p_audit: buildRpcAudit(actor, OVERSPEND_AUDIT_ACTION, "project_budget"),
      p_after: {
        level: next,
        planned_amount: planned,
        actual,
        burn_pct: planned > 0 ? Number(((actual / planned) * 100).toFixed(1)) : 0,
        warn_pct: warnPct,
      },
    });
    if (error) throw error;
    return next;
  } catch (e) {
    console.error("[budget] overspend check failed (never blocks)", e);
    return null;
  }
}

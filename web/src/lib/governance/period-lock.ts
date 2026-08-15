import type { SupabaseClient } from "@supabase/supabase-js";
import { RuleError } from "@/lib/api/errors";

/**
 * Period-close lock (L-32 -> R-76) application-layer guard — the route-level
 * half of a triplicate enforcement (UI marker on week-grid.tsx + this guard,
 * called from time-entries POST/DELETE + the DB backstop trigger, migration
 * 20260815000040, errcode P0011). Mirrors lock.ts's project-lock guard shape:
 * query the relevant approval state and throw a clean 422 BEFORE the write,
 * so a caller never sees the trigger's raw 500-shaped Postgres error.
 *
 * A member's week is LOCKED once an APPROVED timesheet_submission covers the
 * entry's date. There is no update route on time_entries, so only create and
 * delete need guarding. Reopen the submission (governed "reopened" decision
 * verb) to unlock the week again.
 */

/** True when `entryDate` falls within [periodStart, periodEnd] inclusive. ISO (YYYY-MM-DD) dates sort lexically, so a plain string compare is exact — no Date parsing needed. */
export function dateWithinPeriod(entryDate: string, periodStart: string, periodEnd: string): boolean {
  return entryDate >= periodStart && entryDate <= periodEnd;
}

/**
 * Throws RuleError (422, code "period_locked") if `memberId`'s week
 * containing `entryDate` is locked (an approved submission covers it).
 * At most one submission can be in an "open" state (submitted|approved) per
 * member+period at a time (uniq_open_timesheet, migration 0038), so at most
 * one approved row can ever cover a given date — but this checks every
 * approved row for the member defensively rather than assuming that
 * invariant holds forever.
 */
export async function assertWeekUnlocked(
  db: SupabaseClient,
  memberId: string,
  entryDate: string,
): Promise<void> {
  const { data: approved, error } = await db
    .from("timesheet_submissions")
    .select("period_start, period_end")
    .eq("member_id", memberId)
    .eq("status", "approved");

  if (error) throw new Error(error.message);

  const locked = (approved ?? []).some((s: { period_start: string; period_end: string }) =>
    dateWithinPeriod(entryDate, s.period_start, s.period_end),
  );

  if (locked) {
    throw new RuleError(
      "This week's timesheet is approved and locked — reopen the submission before changing time entries.",
      "period_locked",
    );
  }
}

/**
 * True if `error` (from a Supabase insert/delete call) is the DB backstop
 * trigger's PERIOD_LOCKED error (errcode P0011). Belt-and-suspenders mapper
 * used at the insert/delete call site itself — assertWeekUnlocked above is
 * the primary defense (runs first, throws before the write); this catches
 * the rare TOCTOU window between that check and the write reaching the DB.
 */
export function isPeriodLockedError(
  error: { message?: string | null; code?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  const m = `${error.message ?? ""} ${error.code ?? ""}`;
  return m.includes("PERIOD_LOCKED") || error.code === "P0011";
}

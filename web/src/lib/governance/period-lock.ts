import type { SupabaseClient } from "@supabase/supabase-js";
import { RuleError } from "@/lib/api/errors";

/**
 * Timesheet week lock (L-32 -> R-76, widened by red-team R1/H2) application-
 * layer guard — the route-level half of a triplicate enforcement (UI marker on
 * week-grid.tsx + this guard, called from time-entries POST/DELETE + the DB
 * backstop trigger, migrations 20260815000040 and 20261017000049, errcodes
 * P0011 / P0012). Mirrors lock.ts's project-lock guard shape: query the
 * relevant approval state and throw a clean 422 BEFORE the write, so a caller
 * never sees the trigger's raw 500-shaped Postgres error.
 *
 * A member's week is FROZEN while a timesheet_submission covers the entry's
 * date and is in either of two states:
 *   - APPROVED  -> `period_locked`   (the period-close lock, R-76)
 *   - SUBMITTED -> `timesheet_locked` (the sheet is under review: what the
 *     approver is looking at must be what they approve). Not frozen once the
 *     sheet was REOPENED (`reopened_at` set): reopen is the governed unlock
 *     verb, and the edits it exists for are bound by the content digest at the
 *     next approval (see timesheet-decision.ts) instead of being forbidden.
 * Rejecting a sheet (or reopening an approved one) unfreezes the week. There
 * is no update route on time_entries, so only create and delete need guarding.
 */

/** True when `entryDate` falls within [periodStart, periodEnd] inclusive. ISO (YYYY-MM-DD) dates sort lexically, so a plain string compare is exact — no Date parsing needed. */
export function dateWithinPeriod(entryDate: string, periodStart: string, periodEnd: string): boolean {
  return entryDate >= periodStart && entryDate <= periodEnd;
}

export const PERIOD_LOCKED_MESSAGE =
  "This week's timesheet is approved and locked — reopen the submission before changing time entries.";
export const TIMESHEET_LOCKED_MESSAGE =
  "This week's timesheet is submitted and awaiting a decision, so its time entries are frozen — wait for the decision (a rejection unlocks the week) before changing them.";

export type WeekLockRow = {
  period_start: string;
  period_end: string;
  status?: string | null;
  reopened_at?: string | null;
};

export type WeekLockState = "approved" | "under_review" | null;

/**
 * Which lock (if any) the given submissions put on `entryDate`. At most one
 * submission can be open (submitted|approved) per member+period
 * (uniq_open_timesheet, migration 0038), but every row is checked defensively
 * rather than assuming that invariant holds forever; approved outranks
 * under-review. A row without a `status` is read as approved (the shape this
 * function was called with before the under-review lock existed).
 */
export function weekLockState(entryDate: string, submissions: readonly WeekLockRow[]): WeekLockState {
  let state: WeekLockState = null;
  for (const s of submissions) {
    if (!dateWithinPeriod(entryDate, s.period_start, s.period_end)) continue;
    const status = s.status ?? "approved";
    if (status === "approved") return "approved";
    if (status === "submitted" && !s.reopened_at) state = "under_review";
  }
  return state;
}

/**
 * Throws RuleError (422) if `memberId`'s week containing `entryDate` is frozen:
 * code `period_locked` when an approved submission covers it, `timesheet_locked`
 * when one is under review.
 */
export async function assertWeekUnlocked(
  db: SupabaseClient,
  memberId: string,
  entryDate: string,
): Promise<void> {
  const { data: open, error } = await db
    .from("timesheet_submissions")
    .select("period_start, period_end, status, reopened_at")
    .eq("member_id", memberId)
    .in("status", ["submitted", "approved"]);

  if (error) throw new Error(error.message);

  const state = weekLockState(entryDate, (open ?? []) as WeekLockRow[]);
  if (state === "approved") throw new RuleError(PERIOD_LOCKED_MESSAGE, "period_locked");
  if (state === "under_review") throw new RuleError(TIMESHEET_LOCKED_MESSAGE, "timesheet_locked");
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

/** True if `error` is the DB backstop trigger's TIMESHEET_LOCKED error (errcode P0012) — a week whose sheet is under review. */
export function isTimesheetLockedError(
  error: { message?: string | null; code?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  const m = `${error.message ?? ""} ${error.code ?? ""}`;
  return m.includes("TIMESHEET_LOCKED") || error.code === "P0012";
}

/** The 422 RuleError for either lock trigger's error, or null when `error` is neither. */
export function weekLockRuleError(
  error: { message?: string | null; code?: string | null } | null | undefined,
): RuleError | null {
  if (isPeriodLockedError(error)) return new RuleError(PERIOD_LOCKED_MESSAGE, "period_locked");
  if (isTimesheetLockedError(error)) return new RuleError(TIMESHEET_LOCKED_MESSAGE, "timesheet_locked");
  return null;
}

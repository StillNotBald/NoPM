import { z } from "zod";

/** Plain YYYY-MM-DD — matches the `date` column type (no time component). */
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)");

/** True when `dateStr` (YYYY-MM-DD) falls on a Monday (UTC, matching the `date` column semantics). */
export function isMonday(dateStr: string): boolean {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.getUTCDay() === 1;
}

export const createTimesheetSubmissionSchema = z.object({
  member_id: z.string().uuid("member_id must be a UUID"),
  period_start: dateOnly.refine(isMonday, { message: "period_start must be a Monday" }),
});

export const TIMESHEET_STATUSES = ["submitted", "approved", "rejected"] as const;
export const TimesheetStatus = z.enum(TIMESHEET_STATUSES);

// Rationale is intentionally NOT required at the schema layer — it is
// required conditionally (only when decision='rejected' or 'reopened'),
// enforced in the route via assertRationaleOnReject so the 422 message is
// specific to the decision, matching D1 (f2b-specs.md). "reopened" (R-76/
// L-32) is the governed unlock verb: approved-only precondition
// (assertReopenable), rationale required, self-reopen blocked — same guard
// symmetry as approve/reject (lib/governance/timesheet-decision.ts).
export const timesheetDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected", "reopened"], {
    error: "decision must be approved, rejected, or reopened",
  }),
  rationale: z.string().min(1).optional(),
});

export type CreateTimesheetSubmissionInput = z.infer<typeof createTimesheetSubmissionSchema>;
export type TimesheetDecisionInput = z.infer<typeof timesheetDecisionSchema>;

import { z } from "zod";

export const upsertBudgetSchema = z.object({
  planned_amount: z.number().nonnegative("planned_amount must be >= 0"),
  committed_amount: z.number().nonnegative("committed_amount must be >= 0").optional().default(0),
  currency: z.string().min(1).max(10).optional().default("USD"),
  // ── Content enrichment (0008): PMBOK actual cost + reserves ─────────────────
  // All numeric(14,2) >= 0 with a DB default of 0; kept optional so existing
  // upserts that omit them continue to work (the column default applies).
  actual_amount: z.number().nonnegative("actual_amount must be >= 0").optional(),
  contingency_reserve: z.number().nonnegative("contingency_reserve must be >= 0").optional(),
  management_reserve: z.number().nonnegative("management_reserve must be >= 0").optional(),
  // Decision 19: warn when actual reaches this % of plan (over is always 100%).
  overspend_warn_pct: z.number().int().min(1).max(100).optional(),
  // B3: manual to-finish estimate beyond committed (null clears it) and which forecast is reported as EAC.
  estimate_to_complete: z.number().nonnegative("estimate_to_complete must be >= 0").max(999_999_999_999).nullable().optional(),
  // Commitments not yet invoiced (null = use committed_amount). Lower it as invoices arrive; actual = expenses only.
  committed_open: z.number().nonnegative("committed_open must be >= 0").max(999_999_999_999).nullable().optional(),
  forecast_method: z.enum(["cpi", "bottom_up"], { error: "forecast_method must be cpi or bottom_up" }).optional(),
});

export type UpsertBudgetInput = z.infer<typeof upsertBudgetSchema>;

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
});

export type UpsertBudgetInput = z.infer<typeof upsertBudgetSchema>;

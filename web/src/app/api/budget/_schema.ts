import { z } from "zod";

export const upsertBudgetSchema = z.object({
  planned_amount: z.number().nonnegative("planned_amount must be >= 0"),
  committed_amount: z.number().nonnegative("committed_amount must be >= 0").optional().default(0),
  currency: z.string().min(1).max(10).optional().default("USD"),
});

export type UpsertBudgetInput = z.infer<typeof upsertBudgetSchema>;

import { z } from "zod";

const severityEnum = z.enum(["low", "medium", "high", "critical"]);
const likelihoodEnum = z.enum(["low", "medium", "high", "critical"]);
const statusEnum = z.enum(["open", "mitigating", "closed", "accepted"]);

// ── Content-enrichment (0008) — PMBOK risk-register fields ──────────────────
// All additive + optional/nullable; risk_score / exposure stay computed read-side.
const responseStrategyEnum = z.enum(["avoid", "transfer", "mitigate", "accept"]);
const riskCategoryEnum = z.enum([
  "technical",
  "schedule",
  "cost",
  "resourcing",
  "scope_requirements",
  "supplier_external",
  "regulatory_legal",
  "organisational",
]);
const impactAreaEnum = z.enum([
  "schedule",
  "cost",
  "scope",
  "quality",
  "reputation",
  "compliance",
]);
const probabilityPctSchema = z
  .number()
  .int("probability_pct must be an integer")
  .min(0, "probability_pct must be between 0 and 100")
  .max(100, "probability_pct must be between 0 and 100");
const impactScoreSchema = z
  .number()
  .int("impact_score must be an integer")
  .min(1, "impact_score must be between 1 and 5")
  .max(5, "impact_score must be between 1 and 5");

export const createRiskSchema = z.object({
  title: z.string().min(1, "title is required").max(255),
  description: z.string().optional().nullable(),
  severity: severityEnum,
  likelihood: likelihoodEnum,
  category: z.string().max(100).optional().nullable(),
  mitigation: z.string().optional().nullable(),
  owner_id: z.string().uuid("owner_id must be a valid UUID").optional().nullable(),
  status: statusEnum.optional().default("open"),
  raised_at: z.string().datetime({ offset: true }).optional().nullable(),
  due_date: z.string().datetime({ offset: true }).optional().nullable(),
  // Content-enrichment (0008) — all optional/nullable
  probability_pct: probabilityPctSchema.optional().nullable(),
  impact_score: impactScoreSchema.optional().nullable(),
  response_strategy: responseStrategyEnum.optional().default("mitigate"),
  risk_category: riskCategoryEnum.optional().nullable(),
  impact_area: impactAreaEnum.optional().nullable(),
  trigger: z.string().optional().nullable(),
  residual_risk: z.string().optional().nullable(),
  // Q-WRK-19 (migration 0080): how a closed risk was resolved - required to close.
  resolution: z.string().max(4000).optional().nullable(),
  // ── complement seam (0041, R-81) — additive, all optional/nullable ───────────
  source: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).nullable().optional(),
  external_ref: z.string().min(1).max(200).nullable().optional(),
  external_url: z
    .string()
    .url()
    .max(2000)
    .refine((v) => /^https?:\/\//i.test(v), { message: "external_url must be an http(s) URL" })
    .nullable()
    .optional(),
});

export const updateRiskSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().optional().nullable(),
  severity: severityEnum.optional(),
  likelihood: likelihoodEnum.optional(),
  category: z.string().max(100).optional().nullable(),
  mitigation: z.string().optional().nullable(),
  owner_id: z.string().uuid("owner_id must be a valid UUID").optional().nullable(),
  status: statusEnum.optional(),
  raised_at: z.string().datetime({ offset: true }).optional().nullable(),
  due_date: z.string().datetime({ offset: true }).optional().nullable(),
  // Content-enrichment (0008) — all optional/nullable
  probability_pct: probabilityPctSchema.optional().nullable(),
  impact_score: impactScoreSchema.optional().nullable(),
  response_strategy: responseStrategyEnum.optional(),
  risk_category: riskCategoryEnum.optional().nullable(),
  impact_area: impactAreaEnum.optional().nullable(),
  trigger: z.string().optional().nullable(),
  residual_risk: z.string().optional().nullable(),
  // Q-WRK-19 (migration 0080): how a closed risk was resolved - required to close.
  resolution: z.string().max(4000).optional().nullable(),
  // ── complement seam (0041, R-81) — additive, all optional/nullable ───────────
  source: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/).nullable().optional(),
  external_ref: z.string().min(1).max(200).nullable().optional(),
  external_url: z
    .string()
    .url()
    .max(2000)
    .refine((v) => /^https?:\/\//i.test(v), { message: "external_url must be an http(s) URL" })
    .nullable()
    .optional(),
  // ── Optimistic concurrency (R-90) — opt-in. When sent, must match the row's
  // current updated_at or the PATCH is rejected with 412 (see @/lib/api/occ).
  expected_updated_at: z.string().datetime({ offset: true }).optional(),
});

export type CreateRiskInput = z.infer<typeof createRiskSchema>;
export type UpdateRiskInput = z.infer<typeof updateRiskSchema>;

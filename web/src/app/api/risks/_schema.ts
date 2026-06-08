import { z } from "zod";

const severityEnum = z.enum(["low", "medium", "high", "critical"]);
const likelihoodEnum = z.enum(["low", "medium", "high", "critical"]);
const statusEnum = z.enum(["open", "mitigating", "closed", "accepted"]);

// ── Content-enrichment (0008) — PMBOK risk-register fields ──────────────────
// All additive + optional/nullable; risk_score / exposure stay computed read-side.
const responseStrategyEnum = z.enum(["avoid", "transfer", "mitigate", "accept"]);
const riskCategoryEnum = z.enum([
  "timeline_schedule",
  "dependencies_third_party",
  "operational_continuity",
  "technology_infrastructure",
  "financial_capex",
  "resource_management",
  "scope_management",
  "data_information",
  "compliance_regulatory",
  "change_stakeholder",
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
});

export type CreateRiskInput = z.infer<typeof createRiskSchema>;
export type UpdateRiskInput = z.infer<typeof updateRiskSchema>;

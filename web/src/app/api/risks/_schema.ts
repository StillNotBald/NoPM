import { z } from "zod";
import { RISK_IMPACT_AREAS } from "@/lib/risk/impact-areas";

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
const impactAreaEnum = z.enum(RISK_IMPACT_AREAS);
const impactAreasSchema = z.array(impactAreaEnum).max(6, "impact_areas has at most 6 entries");
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

// K1 (0090): the legacy free-text `category` is no longer accepted - use `risk_category`.
// The unknown-field guard (Q-WRK-18) turns a stale `category` into a 422, not a silent drop.
export const createRiskSchema = z.object({
  title: z.string().min(1, "title is required").max(255),
  description: z.string().optional().nullable(),
  severity: severityEnum,
  likelihood: likelihoodEnum,
  mitigation: z.string().optional().nullable(),
  owner_id: z.string().uuid("owner_id must be a valid UUID").optional().nullable(),
  backup_owner_id: z.string().uuid("backup_owner_id must be a valid UUID").optional().nullable(),
  status: statusEnum.optional().default("open"),
  raised_at: z.string().datetime({ offset: true }).optional().nullable(),
  due_date: z.string().datetime({ offset: true }).optional().nullable(),
  // Content-enrichment (0008) — all optional/nullable
  probability_pct: probabilityPctSchema.optional().nullable(),
  impact_score: impactScoreSchema.optional().nullable(),
  response_strategy: responseStrategyEnum.optional().default("mitigate"),
  risk_category: riskCategoryEnum.optional().nullable(),
  // K2 (0091): a risk can touch several areas. `impact_areas` is the source of truth;
  // `impact_area` stays as a one-element shorthand (the array wins if both are sent).
  impact_area: impactAreaEnum.optional().nullable(),
  impact_areas: impactAreasSchema.optional(),
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
  mitigation: z.string().optional().nullable(),
  owner_id: z.string().uuid("owner_id must be a valid UUID").optional().nullable(),
  backup_owner_id: z.string().uuid("backup_owner_id must be a valid UUID").optional().nullable(),
  status: statusEnum.optional(),
  raised_at: z.string().datetime({ offset: true }).optional().nullable(),
  due_date: z.string().datetime({ offset: true }).optional().nullable(),
  // Content-enrichment (0008) — all optional/nullable
  probability_pct: probabilityPctSchema.optional().nullable(),
  impact_score: impactScoreSchema.optional().nullable(),
  response_strategy: responseStrategyEnum.optional(),
  risk_category: riskCategoryEnum.optional().nullable(),
  // K2 (0091): a risk can touch several areas. `impact_areas` is the source of truth;
  // `impact_area` stays as a one-element shorthand (the array wins if both are sent).
  impact_area: impactAreaEnum.optional().nullable(),
  impact_areas: impactAreasSchema.optional(),
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

/** Normalise the two impact-area inputs to one array (array wins; shorthand becomes one element; duplicates removed). */
export function resolveImpactAreas(input: {
  impact_areas?: string[];
  impact_area?: string | null;
}): string[] | undefined {
  if (input.impact_areas !== undefined) return Array.from(new Set(input.impact_areas));
  if (input.impact_area !== undefined) return input.impact_area ? [input.impact_area] : [];
  return undefined;
}

export type CreateRiskInput = z.infer<typeof createRiskSchema>;
export type UpdateRiskInput = z.infer<typeof updateRiskSchema>;

import { z } from "zod";

const decisionStatusEnum = z.enum(["proposed", "accepted", "superseded", "rejected"]);

/**
 * B1 (audit gaps): the options considered, as a list with the one chosen marked.
 * Lives beside the free-text `options` column, which stays. At most one option is
 * chosen (a decision picks one), and a label appears once.
 */
export const decisionOptionSchema = z.object({
  label: z.string().trim().min(1, "each option needs a label").max(200),
  chosen: z.boolean().optional().default(false),
  note: z.string().max(2_000).optional().nullable(),
});
export const optionsStructuredSchema = z
  .array(decisionOptionSchema)
  .max(20, "at most 20 options")
  .superRefine((list, ctx) => {
    if (list.filter((o) => o.chosen).length > 1) {
      ctx.addIssue({ code: "custom", message: "at most one option can be marked chosen" });
    }
    const labels = list.map((o) => o.label.toLowerCase());
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({ code: "custom", message: "option labels must be unique" });
    }
  });
export type DecisionOption = z.infer<typeof decisionOptionSchema>;

const linkFields = {
  /** B1: the change request this decision was taken for (same workspace and project). */
  change_request_id: z.string().uuid("change_request_id must be a valid UUID").optional().nullable(),
  options_structured: optionsStructuredSchema.optional().nullable(),
};

export const createDecisionSchema = z.object({
  title: z.string().min(1, "title is required").max(255),
  context: z.string().max(10_000).optional().nullable(),
  options: z.string().max(10_000).optional().nullable(),
  decision: z.string().max(10_000).optional().nullable(),
  rationale: z.string().max(10_000).optional().nullable(),
  // Omitted: accepted for managers and admins, proposed for everyone else (decision 25).
  status: decisionStatusEnum.optional(),
  decided_at: z.string().datetime({ offset: true }).optional().nullable(),
  supersedes: z.string().uuid("supersedes must be a valid UUID").optional().nullable(),
  ...linkFields,
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

export const updateDecisionSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  context: z.string().max(10_000).optional().nullable(),
  options: z.string().max(10_000).optional().nullable(),
  decision: z.string().max(10_000).optional().nullable(),
  rationale: z.string().max(10_000).optional().nullable(),
  status: decisionStatusEnum.optional(),
  decided_at: z.string().datetime({ offset: true }).optional().nullable(),
  supersedes: z.string().uuid("supersedes must be a valid UUID").optional().nullable(),
  ...linkFields,
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

export type CreateDecisionInput = z.infer<typeof createDecisionSchema>;
export type UpdateDecisionInput = z.infer<typeof updateDecisionSchema>;

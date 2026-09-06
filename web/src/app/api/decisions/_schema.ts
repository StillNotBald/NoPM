import { z } from "zod";

const decisionStatusEnum = z.enum(["proposed", "accepted", "superseded", "rejected"]);

export const createDecisionSchema = z.object({
  title: z.string().min(1, "title is required").max(255),
  context: z.string().optional().nullable(),
  options: z.string().optional().nullable(),
  decision: z.string().optional().nullable(),
  rationale: z.string().optional().nullable(),
  status: decisionStatusEnum.optional().default("accepted"),
  decided_at: z.string().datetime({ offset: true }).optional().nullable(),
  supersedes: z.string().uuid("supersedes must be a valid UUID").optional().nullable(),
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
  context: z.string().optional().nullable(),
  options: z.string().optional().nullable(),
  decision: z.string().optional().nullable(),
  rationale: z.string().optional().nullable(),
  status: decisionStatusEnum.optional(),
  decided_at: z.string().datetime({ offset: true }).optional().nullable(),
  supersedes: z.string().uuid("supersedes must be a valid UUID").optional().nullable(),
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

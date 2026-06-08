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
});

export type CreateDecisionInput = z.infer<typeof createDecisionSchema>;
export type UpdateDecisionInput = z.infer<typeof updateDecisionSchema>;

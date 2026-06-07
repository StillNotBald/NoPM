import { z } from "zod";

const severityEnum = z.enum(["low", "medium", "high", "critical"]);
const likelihoodEnum = z.enum(["low", "medium", "high", "critical"]);
const statusEnum = z.enum(["open", "mitigating", "closed", "accepted"]);

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
});

export type CreateRiskInput = z.infer<typeof createRiskSchema>;
export type UpdateRiskInput = z.infer<typeof updateRiskSchema>;

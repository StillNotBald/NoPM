import { z } from "zod";

const categoryEnum = z.enum(["scope", "schedule", "cost", "quality", "resource", "other"]);
const priorityEnum = z.enum(["low", "medium", "high", "critical"]);
const statusEnum = z.enum(["raised", "under_review", "approved", "rejected", "deferred", "implemented"]);

export const createChangeRequestSchema = z.object({
  title: z.string().min(1, "title is required").max(255),
  description: z.string().optional().nullable(),
  category: categoryEnum.optional().default("scope"),
  priority: priorityEnum.optional().default("medium"),
  status: statusEnum.optional().default("raised"),
  impact_summary: z.string().optional().nullable(),
  impact_schedule_days: z.number().int().optional().nullable(),
  impact_cost: z.number().optional().nullable(),
  target_date: z.string().date().optional().nullable(),
  raised_at: z.string().datetime({ offset: true }).optional().nullable(),
});

// NOTE: `status` is intentionally NOT updatable here — all status transitions
// (approve / reject / defer / implement) must go through the audited four-eyes
// /decision endpoint, so the governance trail + requester notification fire and
// the decider≠requester check is enforced. See SECURITY-REVIEW-2026-06-10.
export const updateChangeRequestSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().optional().nullable(),
  category: categoryEnum.optional(),
  priority: priorityEnum.optional(),
  impact_summary: z.string().optional().nullable(),
  impact_schedule_days: z.number().int().optional().nullable(),
  impact_cost: z.number().optional().nullable(),
  target_date: z.string().date().optional().nullable(),
  raised_at: z.string().datetime({ offset: true }).optional().nullable(),
});

export const decisionActionSchema = z.object({
  decision: z.enum(["approve", "reject", "defer"], {
    error: "decision must be approve, reject, or defer",
  }),
  rationale: z.string().min(1, "rationale is required"),
});

export type CreateChangeRequestInput = z.infer<typeof createChangeRequestSchema>;
export type UpdateChangeRequestInput = z.infer<typeof updateChangeRequestSchema>;
export type DecisionActionInput = z.infer<typeof decisionActionSchema>;

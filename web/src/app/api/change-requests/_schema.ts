import { z } from "zod";

const categoryEnum = z.enum(["scope", "schedule", "cost", "quality", "resource", "other"]);
const priorityEnum = z.enum(["low", "medium", "high", "critical"]);

/**
 * The only statuses a change request can be RAISED in. Every terminal status
 * needs a decider (the cr_maker_checker CHECK), so accepting one at creation
 * used to surface as a raw database constraint error (UC-10); it also made a
 * request that skipped four-eyes look legitimate. Approve / reject / defer go
 * through POST /api/change-requests/:id/decision.
 */
export const RAISE_TIME_STATUSES = ["raised", "under_review"] as const;
const raiseStatusEnum = z.enum(RAISE_TIME_STATUSES, {
  error: "status must be raised or under_review when raising a change request; use /decision to approve, reject or defer",
});

export const createChangeRequestSchema = z.object({
  title: z.string().min(1, "title is required").max(255),
  description: z.string().optional().nullable(),
  category: categoryEnum.optional().default("scope"),
  priority: priorityEnum.optional().default("medium"),
  status: raiseStatusEnum.optional().default("raised"),
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

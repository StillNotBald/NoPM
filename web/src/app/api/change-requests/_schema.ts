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
  description: z.string().max(10_000).optional().nullable(),
  category: categoryEnum.optional().default("scope"),
  priority: priorityEnum.optional().default("medium"),
  status: raiseStatusEnum.optional().default("raised"),
  impact_summary: z.string().max(10_000).optional().nullable(),
  impact_schedule_days: z.number().int().min(-36500).max(36500).optional().nullable(),
  impact_cost: z.number().min(-999_999_999_999).max(999_999_999_999).optional().nullable(),
  target_date: z.string().date().optional().nullable(),
  raised_at: z.string().datetime({ offset: true }).optional().nullable(),
});

// NOTE: `status` is intentionally NOT updatable here — all status transitions
// (approve / reject / defer / implement) must go through the audited four-eyes
// /decision endpoint, so the governance trail + requester notification fire and
// the decider≠requester check is enforced. See SECURITY-REVIEW-2026-06-10.
export const updateChangeRequestSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().max(10_000).optional().nullable(),
  category: categoryEnum.optional(),
  priority: priorityEnum.optional(),
  impact_summary: z.string().max(10_000).optional().nullable(),
  impact_schedule_days: z.number().int().min(-36500).max(36500).optional().nullable(),
  impact_cost: z.number().min(-999_999_999_999).max(999_999_999_999).optional().nullable(),
  target_date: z.string().date().optional().nullable(),
  raised_at: z.string().datetime({ offset: true }).optional().nullable(),
});

/**
 * POST /api/change-requests/:id/decision. Common-pattern rules (2026-10-17):
 *   - rationale: REQUIRED for reject (Q-GOV-21) and defer; optional for approve.
 *   - expected_updated_at: REQUIRED for approve and reject (Q-GOV-13): the
 *     `updated_at` of the change request the decider was looking at. If it was
 *     edited since, the decision is refused with 412 instead of approving content
 *     the approver never saw. (Defer decides nothing on content, so it stays opt-in.)
 *
 * Both rules are enforced in decideChangeRequest (422 rationale_required /
 * version_required), AFTER the scope, role and four-eyes checks, so a caller who
 * may not decide at all still gets the 403 and not a validation message.
 */
export const decisionActionSchema = z.object({
  decision: z.enum(["approve", "reject", "defer"], {
    error: "decision must be approve, reject, or defer",
  }),
  rationale: z.string().max(10_000).optional().nullable(),
  expected_updated_at: z.string().datetime({ offset: true }).optional(),
});

export type CreateChangeRequestInput = z.infer<typeof createChangeRequestSchema>;
export type UpdateChangeRequestInput = z.infer<typeof updateChangeRequestSchema>;
export type DecisionActionInput = z.infer<typeof decisionActionSchema>;

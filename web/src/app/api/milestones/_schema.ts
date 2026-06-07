import { z } from "zod";

export const MILESTONE_STATUSES = [
  "not_started",
  "on_track",
  "at_risk",
  "delayed",
  "completed",
] as const;

export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const createMilestoneSchema = z.object({
  name: z.string().min(1, "Name is required").max(255),
  target_date: z.string().datetime({ offset: true }).nullable().optional(),
  status: z.enum(MILESTONE_STATUSES).default("not_started"),
  completion_pct: z.number().int().min(0).max(100).default(0),
  owner_id: z.string().uuid().nullable().optional(),
  sort_order: z.number().int().min(0).default(0),
});

export const updateMilestoneSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  target_date: z.string().datetime({ offset: true }).nullable().optional(),
  status: z.enum(MILESTONE_STATUSES).optional(),
  completion_pct: z.number().int().min(0).max(100).optional(),
  owner_id: z.string().uuid().nullable().optional(),
  sort_order: z.number().int().min(0).optional(),
});

export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;
export type UpdateMilestoneInput = z.infer<typeof updateMilestoneSchema>;

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
  // Content-enrichment P0 fields (additive, all optional/nullable)
  description: z.string().nullable().optional(),
  deliverable: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(), // ISO date string
  baseline_target_date: z.string().nullable().optional(), // ISO date string
  actual_date: z.string().nullable().optional(), // ISO date string
});

export const updateMilestoneSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  target_date: z.string().datetime({ offset: true }).nullable().optional(),
  status: z.enum(MILESTONE_STATUSES).optional(),
  completion_pct: z.number().int().min(0).max(100).optional(),
  owner_id: z.string().uuid().nullable().optional(),
  sort_order: z.number().int().min(0).optional(),
  // Content-enrichment P0 fields (additive, all optional/nullable)
  description: z.string().nullable().optional(),
  deliverable: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(), // ISO date string
  baseline_target_date: z.string().nullable().optional(), // ISO date string
  actual_date: z.string().nullable().optional(), // ISO date string
  // Q-WRK-14: completing a milestone that still has open tasks needs this
  // confirmation (the API answers 422 `open_tasks` first). Never stored.
  confirm_open_tasks: z.boolean().optional(),
  // ── Optimistic concurrency (R-90) — opt-in. When sent, must match the row's
  // current updated_at or the PATCH is rejected with 412 (see @/lib/api/occ).
  expected_updated_at: z.string().datetime({ offset: true }).optional(),
});

export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;
export type UpdateMilestoneInput = z.infer<typeof updateMilestoneSchema>;

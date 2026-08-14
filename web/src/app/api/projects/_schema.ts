import { z } from "zod";

// PMBOK process groups — backs the `phase` column (content-enrichment 0008).
const projectPhase = z.enum([
  "initiation",
  "planning",
  "execution",
  "monitoring",
  "closing",
]);

export const createProjectSchema = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  program: z.string().optional(),
  owner_id: z.string().uuid().optional(),
  rag_status: z
    .enum(["not_started", "red", "amber", "green", "complete"])
    .optional(),
  completion_pct: z.number().min(0).max(100).optional(),
  start_date: z.string().optional(), // ISO date string
  target_date: z.string().optional(), // ISO date string
  currency: z.string().length(3).optional(),
  is_locked: z.boolean().optional(),
  // ── Content enrichment (0008): PMBOK charter + baseline pair + phase ──────
  business_case: z.string().nullish(),
  objective: z.string().nullish(),
  scope_summary: z.string().nullish(),
  sponsor: z.string().nullish(),
  project_manager: z.string().nullish(),
  phase: projectPhase.optional(),
  health_commentary: z.string().nullish(),
  baseline_start_date: z.string().nullish(), // ISO date string
  baseline_target_date: z.string().nullish(), // ISO date string
});

export const updateProjectSchema = z.object({
  code: z.string().min(1).max(32).optional(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  program: z.string().optional(),
  owner_id: z.string().uuid().optional(),
  rag_status: z
    .enum(["not_started", "red", "amber", "green", "complete"])
    .optional(),
  completion_pct: z.number().min(0).max(100).optional(),
  start_date: z.string().optional(),
  target_date: z.string().optional(),
  currency: z.string().length(3).optional(),
  // is_locked intentionally NOT accepted here — lock state may only change via
  // the dedicated POST /api/projects/[id]/lock and /unlock routes (governance:
  // generic PATCH must never be able to flip the baseline-freeze flag).
  // ── Content enrichment (0008): PMBOK charter + baseline pair + phase ──────
  business_case: z.string().nullish(),
  objective: z.string().nullish(),
  scope_summary: z.string().nullish(),
  sponsor: z.string().nullish(),
  project_manager: z.string().nullish(),
  phase: projectPhase.optional(),
  health_commentary: z.string().nullish(),
  baseline_start_date: z.string().nullish(),
  baseline_target_date: z.string().nullish(),
});

// Maker step for project deletion (four-eyes, Decision 3 devops-wave1) — mirrors
// TaskDeleteRequestSchema (web/src/app/api/tasks/_schema.ts): reason is required
// so the audit trail always records *why* a deletion was requested.
export const ProjectDeleteRequestSchema = z.object({
  reason: z.string().min(1, "reason is required").max(1000),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type ProjectDeleteRequestInput = z.infer<typeof ProjectDeleteRequestSchema>;

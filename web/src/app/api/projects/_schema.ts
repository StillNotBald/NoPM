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
  // D-WRK-4: program membership write path (must belong to the caller's workspace).
  program_id: z.string().uuid().nullable().optional(),
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

export const updateProjectSchema = z.object({
  code: z.string().min(1).max(32).optional(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  program: z.string().optional(),
  program_id: z.string().uuid().nullable().optional(),
  owner_id: z.string().uuid().optional(),
  rag_status: z
    .enum(["not_started", "red", "amber", "green", "complete"])
    .optional(),
  // Accepted for echo-compat only: the route refuses a value that differs from
  // the stored one (422) because completion is calculated from the tasks.
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
  // ── Optimistic concurrency (R-90) — opt-in. When sent, must match the row's
  // current updated_at or the PATCH is rejected with 412 (see @/lib/api/occ).
  expected_updated_at: z.string().datetime({ offset: true }).optional(),
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

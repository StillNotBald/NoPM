import { z } from "zod";

/** Plain YYYY-MM-DD — matches the `date` column type (no time component). */
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)");

export const SPRINT_STATES = ["planned", "active", "closed"] as const;
export const SprintState = z.enum(SPRINT_STATES);

export const createSprintSchema = z.object({
  project_id: z.string().uuid("project_id must be a UUID"),
  name: z.string().min(1, "name is required").max(120),
  goal: z.string().max(2000).nullable().optional(),
  start_date: dateOnly,
  end_date: dateOnly,
});

/**
 * PATCH only ever touches name/goal/dates — `state` is NEVER settable here
 * (transitions go exclusively through POST /start and POST /close, each with
 * their own governed snapshot side-effects). The route additionally rejects
 * any PATCH once the sprint is closed (dates immutable once closed).
 */
export const updateSprintSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  goal: z.string().max(2000).nullable().optional(),
  start_date: dateOnly.optional(),
  end_date: dateOnly.optional(),
});

export const sprintTaskAttachSchema = z.object({
  task_id: z.string().uuid("task_id must be a UUID"),
});

export type CreateSprintInput = z.infer<typeof createSprintSchema>;
export type UpdateSprintInput = z.infer<typeof updateSprintSchema>;
export type SprintTaskAttachInput = z.infer<typeof sprintTaskAttachSchema>;

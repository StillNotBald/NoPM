import { z } from "zod";

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
  is_locked: z.boolean().optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

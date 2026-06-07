import { z } from "zod";

export const StatusType = z.enum([
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
]);

export const Priority = z.enum(["low", "medium", "high", "urgent"]);

export const TaskCreateSchema = z.object({
  // id/workspace_id/project_id are taken from the route, ignored from body
  project_id: z.string().uuid("project_id must be a UUID").optional(),
  milestone_id: z.string().uuid("milestone_id must be a UUID").nullable().optional(),
  name: z.string().min(1, "name is required").max(255),
  description: z.string().nullable().optional(),
  status: z.string().max(100).nullable().optional(),
  status_type: StatusType.optional().default("backlog"),
  assignee_id: z.string().uuid("assignee_id must be a UUID").nullable().optional(),
  priority: Priority.optional().default("medium"),
  start_date: z.string().nullable().optional(), // ISO date string
  due_date: z.string().nullable().optional(),
  completion_pct: z.number().int().min(0).max(100).optional().default(0),
  sort_order: z.number().int().optional(),
});

export const TaskUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  status: z.string().max(100).nullable().optional(),
  status_type: StatusType.optional(),
  assignee_id: z.string().uuid("assignee_id must be a UUID").nullable().optional(),
  priority: Priority.optional(),
  start_date: z.string().nullable().optional(),
  due_date: z.string().nullable().optional(),
  completion_pct: z.number().int().min(0).max(100).optional(),
  sort_order: z.number().int().optional(),
  milestone_id: z.string().uuid("milestone_id must be a UUID").nullable().optional(),
}).strict();

export const TaskDeleteRequestSchema = z.object({
  reason: z.string().min(1, "reason is required").max(1000),
});

export type TaskCreateInput = z.infer<typeof TaskCreateSchema>;
export type TaskUpdateInput = z.infer<typeof TaskUpdateSchema>;
export type TaskDeleteRequestInput = z.infer<typeof TaskDeleteRequestSchema>;

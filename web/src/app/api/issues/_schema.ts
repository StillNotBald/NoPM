import { z } from "zod";

const priorityEnum = z.enum(["low", "medium", "high", "urgent"]);
const statusEnum = z.enum(["open", "in_progress", "resolved", "closed"]);

export const createIssueSchema = z.object({
  title: z.string().min(1, "title is required").max(255),
  description: z.string().optional().nullable(),
  priority: priorityEnum,
  resolution: z.string().optional().nullable(),
  owner_id: z.string().uuid("owner_id must be a valid UUID").optional().nullable(),
  status: statusEnum.optional().default("open"),
  raised_at: z.string().datetime({ offset: true }).optional().nullable(),
  due_date: z.string().datetime({ offset: true }).optional().nullable(),
});

export const updateIssueSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  description: z.string().optional().nullable(),
  priority: priorityEnum.optional(),
  resolution: z.string().optional().nullable(),
  owner_id: z.string().uuid("owner_id must be a valid UUID").optional().nullable(),
  status: statusEnum.optional(),
  raised_at: z.string().datetime({ offset: true }).optional().nullable(),
  due_date: z.string().datetime({ offset: true }).optional().nullable(),
});

export type CreateIssueInput = z.infer<typeof createIssueSchema>;
export type UpdateIssueInput = z.infer<typeof updateIssueSchema>;

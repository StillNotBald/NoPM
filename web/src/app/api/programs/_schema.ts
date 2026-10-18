import { z } from "zod";

// Shared with projects.rag_status (migration 0001's `rag_status` enum) — see
// projects/_schema.ts for the same set.
const ragStatusEnum = z.enum(["not_started", "red", "amber", "green", "complete"]);

export const createProgramSchema = z.object({
  code: z.string().min(1).max(32).optional().nullable(),
  name: z.string().min(1).max(255),
  description: z.string().optional().nullable(),
  // resource_members(id) — the costed, capacity-bearing identity (matches
  // tasks.assignee_id since migration 0019), NOT profiles(id).
  owner_id: z.string().uuid().optional().nullable(),
  // Declared health (L-02) — independent of any computed child rollup.
  rag_status: ragStatusEnum.optional(),
});

export const updateProgramSchema = z.object({
  code: z.string().min(1).max(32).optional().nullable(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional().nullable(),
  owner_id: z.string().uuid().optional().nullable(),
  rag_status: ragStatusEnum.optional(),
});

export type CreateProgramInput = z.infer<typeof createProgramSchema>;
export type UpdateProgramInput = z.infer<typeof updateProgramSchema>;

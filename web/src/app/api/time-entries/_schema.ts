import { z } from "zod";

export const createTimeEntrySchema = z.object({
  member_id: z.string().uuid("member_id must be a UUID"),
  task_id: z.string().uuid("task_id must be a UUID").optional().nullable(),
  project_id: z.string().uuid("project_id must be a UUID"),
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "entry_date must be YYYY-MM-DD"),
  hours: z.number().positive("hours must be > 0"),
  note: z.string().max(1000).optional().nullable(),
  // L-29: whether this entry counts as billable. Omitted → defaults from the
  // project's default_billable at create time (see POST /time-entries).
  billable: z.boolean().optional(),
});

export type CreateTimeEntryInput = z.infer<typeof createTimeEntrySchema>;

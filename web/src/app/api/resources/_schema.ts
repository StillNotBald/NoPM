import { z } from "zod";

export const createResourceSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email().optional().nullable(),
  role_title: z.string().max(255).optional().nullable(),
  cost_rate: z.number().nonnegative().optional().nullable(),
  capacity_hours_per_week: z.number().nonnegative().optional().nullable(),
  profile_id: z.string().uuid().optional().nullable(),
});

export const patchResourceSchema = createResourceSchema.partial();

export type CreateResourceInput = z.infer<typeof createResourceSchema>;
export type PatchResourceInput = z.infer<typeof patchResourceSchema>;

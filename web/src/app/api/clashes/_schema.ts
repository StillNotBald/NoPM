import { z } from "zod";

export const ClashTypeEnum = z.enum(["schedule", "resource", "dependency"]);
export const ClashSeverityEnum = z.enum(["low", "medium", "high", "critical"]);
export const ClashStatusEnum = z.enum(["open", "investigating", "resolved"]);

export const createClashSchema = z.object({
  title: z.string().min(1).max(255),
  type: ClashTypeEnum,
  severity: ClashSeverityEnum,
  project_a_id: z.string().uuid().optional().nullable(),
  project_b_id: z.string().uuid().optional().nullable(),
  resource_member_id: z.string().uuid().optional().nullable(),
  window_start: z.string().datetime().optional().nullable(),
  window_end: z.string().datetime().optional().nullable(),
  status: ClashStatusEnum.default("open"),
  owner_id: z.string().uuid().optional().nullable(),
  resolution: z.string().optional().nullable(),
});

export const patchClashSchema = createClashSchema.partial();

export type CreateClashInput = z.infer<typeof createClashSchema>;
export type PatchClashInput = z.infer<typeof patchClashSchema>;

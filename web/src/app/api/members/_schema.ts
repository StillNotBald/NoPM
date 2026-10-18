import { z } from "zod";
import { MEMBER_ROLE_VALUES } from "@/lib/people/members";

export const changeRoleSchema = z.object({
  role: z.enum(MEMBER_ROLE_VALUES, { error: `role must be one of ${MEMBER_ROLE_VALUES.join(", ")}` }),
});

export const restoreSchema = z.object({
  role: z.enum(MEMBER_ROLE_VALUES, { error: `role must be one of ${MEMBER_ROLE_VALUES.join(", ")}` }).optional(),
});

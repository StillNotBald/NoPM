import { z } from "zod";
import { MEMBER_ROLES } from "@/lib/governance/invite-guard";

export const createInviteSchema = z.object({
  email: z.string().email("email must be a valid email address"),
  role: z.enum(MEMBER_ROLES, { error: `role must be one of ${MEMBER_ROLES.join(", ")}` }),
  name: z.string().min(1).max(255).optional().nullable(),
  role_title: z.string().max(255).optional().nullable(),
  cost_rate: z.number().nonnegative().optional(),
  capacity_hours_per_week: z.number().nonnegative().optional(),
});

/**
 * POST /api/invites/accept — public (auth:false). Deliberately has NO email
 * field: the accepted email is always the invite's own (D6) — never
 * something the caller can supply. min(12) matches the password floor NoPM
 * already asks of a manually-created session (login page has no separate
 * policy today, but this is the FIRST route that actually creates a
 * password — D6/T7 locks the floor here explicitly).
 */
export const acceptInviteSchema = z.object({
  token: z.string().min(1, "token is required"),
  password: z.string().min(12, "password must be at least 12 characters"),
  display_name: z.string().min(1, "display_name is required").max(255),
});

export type CreateInviteInput = z.infer<typeof createInviteSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

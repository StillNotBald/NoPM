import { z } from "zod";

// POST /api/projects/[id]/lock
export const lockProjectSchema = z.object({
  reason: z.string().max(1000).optional(),
});

// POST /api/projects/[id]/unlock (R-83) — reason REQUIRED, unlike lock's
// optional reason: unlocking a governed baseline is the more consequential
// act (it reopens dates the lock froze) and the audit trail must carry why.
export const unlockProjectSchema = z.object({
  reason: z.string().min(1, "reason is required").max(1000),
});

// POST /api/projects/[id]/rebaselines (create)
export const createRebaselineSchema = z.object({
  reason: z.string().min(1).max(2000),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});

// POST /api/rebaselines/[id]/signoff
export const signoffSchema = z.object({
  vote: z.enum(["go", "no_go"]),
  comment: z.string().max(2000).optional(),
});

export type LockProjectInput = z.infer<typeof lockProjectSchema>;
export type UnlockProjectInput = z.infer<typeof unlockProjectSchema>;
export type CreateRebaselineInput = z.infer<typeof createRebaselineSchema>;
export type SignoffInput = z.infer<typeof signoffSchema>;

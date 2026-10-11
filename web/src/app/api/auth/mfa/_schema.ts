import { z } from "zod";

/** POST /api/auth/mfa/verify — verify a TOTP code */
export const verifyMfaSchema = z.object({
  code: z.string().min(6).max(8),
});

export type VerifyMfaInput = z.infer<typeof verifyMfaSchema>;

/**
 * POST /api/auth/mfa/challenge (R-91) — a TOTP code (6-8 digits) OR a
 * backup code (32 hex chars, see verify/route.ts's randomBytes(16).toString
 * ("hex")). One loose bound covers both shapes; the route itself tries TOTP
 * first, then falls back to a backup-code hash match.
 */
export const challengeMfaSchema = z.object({
  code: z.string().trim().min(6).max(64),
});

export type ChallengeMfaInput = z.infer<typeof challengeMfaSchema>;

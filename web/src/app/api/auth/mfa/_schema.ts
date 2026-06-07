import { z } from "zod";

/** POST /api/auth/mfa/verify — verify a TOTP code */
export const verifyMfaSchema = z.object({
  code: z.string().min(6).max(8),
});

export type VerifyMfaInput = z.infer<typeof verifyMfaSchema>;

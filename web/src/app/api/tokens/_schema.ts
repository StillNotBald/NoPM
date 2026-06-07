import { z } from "zod";

/**
 * Allowed scope strings follow the `resource:action` convention used across
 * NoPM.  We accept any non-empty string so new scopes can be introduced
 * without a schema change, but reject blank/whitespace entries.
 */
const scopeString = z
  .string()
  .min(1, "Scope must not be empty")
  .regex(/^\S+$/, "Scope must not contain whitespace");

export const createTokenSchema = z.object({
  name: z.string().min(1, "Name is required").max(255),
  scopes: z
    .array(scopeString)
    .min(1, "At least one scope is required")
    .max(100, "Too many scopes"),
  expires_at: z
    .string()
    .datetime({ message: "expires_at must be an ISO-8601 datetime string" })
    .optional(),
});

export type CreateTokenInput = z.infer<typeof createTokenSchema>;

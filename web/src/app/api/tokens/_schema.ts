import { z } from "zod";
import { isValidScope } from "@/lib/auth/scopes";

/**
 * Scope strings follow the `resource:action` convention. A token may only be
 * minted with scopes the system actually enforces (the central registry in
 * @/lib/auth/scopes) — including `<resource>:*` / `*` wildcards — so a bogus
 * scope is rejected at creation rather than silently granted and never matched.
 */
const scopeString = z
  .string()
  .min(1, "Scope must not be empty")
  .regex(/^\S+$/, "Scope must not contain whitespace")
  .refine(isValidScope, { message: "Unknown or unsupported scope" });

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

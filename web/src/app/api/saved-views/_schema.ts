import { z } from "zod";

/**
 * register is validated against the same format the DB CHECK enforces
 * (migration 20260815000035) — lowercase, starts with a letter, letters and
 * underscores only. Not a fixed enum (see the migration's docstring for why).
 */
const registerSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z_]*$/, "register must be lowercase letters/underscores, e.g. tasks");

const scopeSchema = z.enum(["personal", "shared"]);

/** Mirrors src/lib/views/view-config.ts's SavedViewConfig shape, permissively —
 * decodeStoredConfig() is the actual defensive parser applied on read, so this
 * schema only needs to reject obviously-wrong top-level shapes at write time. */
const configSchema = z
  .object({
    filters: z.record(z.string(), z.string()).optional(),
    sort: z
      .object({ field: z.string().min(1), direction: z.enum(["asc", "desc"]) })
      .nullable()
      .optional(),
    columns: z.array(z.string().min(1)).min(1, "at least one column must stay visible").nullable().optional(),
    groupBy: z.string().nullable().optional(),
  })
  .passthrough();

export const createSavedViewSchema = z.object({
  register: registerSchema,
  name: z.string().min(1, "name is required").max(255),
  config: configSchema.optional(),
  scope: scopeSchema.optional().default("personal"),
  protected: z.boolean().optional().default(false),
});

export const updateSavedViewSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    config: configSchema.optional(),
    scope: scopeSchema.optional(),
    protected: z.boolean().optional(),
  })
  .strict();

export type CreateSavedViewInput = z.infer<typeof createSavedViewSchema>;
export type UpdateSavedViewInput = z.infer<typeof updateSavedViewSchema>;

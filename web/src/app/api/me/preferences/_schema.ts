import { z } from "zod";
import { DENSITIES, DATE_DISPLAYS } from "@/lib/theme/appearance";

/**
 * user_preferences.config (L-39) — a CLOSED whitelist of known keys, the DB
 * analogue of appearance.ts's closed preset registry:
 *
 *   columns         per-register visible-column lists (L-11)
 *   groupBy         per-register group-by field (L-09)
 *   density         one of the appearance presets (L-38) — mirrored here so
 *                   it follows the ACCOUNT for a signed-in non-demo user;
 *                   the cookie stays the per-device source of truth (ADR 0009)
 *   dateDisplay     one of the appearance presets (L-42) — same mirroring
 *   defaultLanding  personal default landing page (L-39; overrides any
 *                   workspace-level default from the out-of-scope L-40)
 *   onboarding      first-run wizard state (L-45, D7) — dismiss/resume
 *                   bookkeeping for components/onboarding/first-run-wizard.tsx.
 *                   NEVER persisted for a demo actor (the client checks the
 *                   `demo` flag this same route's GET returns and skips PUT
 *                   entirely — see route.ts's isDemoActor doc comment).
 *   tour            governance tour state (L-50, R-77) — dismiss/visited
 *                   bookkeeping for components/onboarding/governance-tour.tsx.
 *                   Same demo:false PUT-gating as `onboarding` above (a demo
 *                   actor keeps this in component state only, fresh per
 *                   visit — the shared-demo-identity carve-out).
 *
 * `z.object()` (NOT `.strict()`, NOT `.passthrough()`) strips any key
 * outside this whitelist by default — the exact "unknown keys stripped"
 * behaviour the register's acceptance criteria call for. Each field is also
 * independently optional so a partial config (only `density` set, say)
 * round-trips without inventing values for the rest.
 *
 * register keys (in `columns`/`groupBy`) reuse the same lowercase
 * letters/underscores shape saved_views._schema.ts's `registerSchema`
 * validates against, e.g. "tasks", "risks", "change_requests".
 */
const registerKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z_]*$/, "register keys must be lowercase letters/underscores, e.g. tasks");

const columnsSchema = z.record(
  registerKeySchema,
  z.array(z.string().min(1).max(64)).min(1, "at least one column must stay visible").max(50),
);

const groupBySchema = z.record(registerKeySchema, z.string().min(1).max(64).nullable());

/**
 * First-run wizard state (L-45, D7) — the exact shape locked by the F2b
 * decision: `{ completedAt?: ISO string, dismissed?: boolean, step?: number }`.
 * `z.object()` here (matching the parent schema's convention, NOT `.strict()`)
 * means an unrecognised key nested inside `onboarding` is silently stripped
 * too, same as every other top-level key in this file.
 */
const onboardingSchema = z.object({
  completedAt: z.string().datetime().optional(),
  dismissed: z.boolean().optional(),
  step: z.number().int().min(1).max(4).optional(),
});

/**
 * Governance tour state (L-50, R-77) — the shape locked for the F2c-mini T4
 * task: `{ dismissed?: boolean, visited?: string[] (max 12, item ids) }`.
 * Same non-strict convention as every other key here — an unrecognised key
 * nested inside `tour` is silently stripped, not rejected.
 */
const tourSchema = z.object({
  dismissed: z.boolean().optional(),
  visited: z.array(z.string().min(1).max(64)).max(12).optional(),
});

export const preferencesConfigSchema = z.object({
  columns: columnsSchema.optional(),
  groupBy: groupBySchema.optional(),
  density: z.enum(DENSITIES).optional(),
  dateDisplay: z.enum(DATE_DISPLAYS).optional(),
  defaultLanding: z.string().min(1).max(200).optional(),
  onboarding: onboardingSchema.optional(),
  tour: tourSchema.optional(),
});

export type PreferencesConfig = z.infer<typeof preferencesConfigSchema>;

/**
 * PUT request-body shape ({ config: {...} }) — exported so
 * openapi.json/route.ts can generate the documented schema straight from
 * this validator (via zodBody) instead of hand-maintaining a parallel JSON
 * Schema that could silently drift from what PUT actually accepts.
 */
export const putPreferencesBodySchema = z.object({ config: preferencesConfigSchema });

/** Empty config — the fallback shape for a user with no preferences row yet. */
export function emptyPreferencesConfig(): PreferencesConfig {
  return {};
}

/**
 * Size cap (register: "size-capped"). Applied to the SANITIZED
 * (post-Zod-strip) config, not the raw request body, so an attacker can't
 * pad the body with unknown keys to dodge the limit — those never reach
 * storage in the first place. 10 KB comfortably covers a column list per
 * register for every register in the product with room to spare, while
 * still bounding worst-case jsonb row size.
 */
export const MAX_CONFIG_BYTES = 10_000;

export function configSizeBytes(config: unknown): number {
  return JSON.stringify(config ?? {}).length;
}

export function isConfigWithinSizeCap(config: unknown): boolean {
  return configSizeBytes(config) <= MAX_CONFIG_BYTES;
}

/**
 * Defensive decode of a config value read back out of the DB (jsonb →
 * `unknown`). NEVER throws; an unrecognised/corrupt shape falls back to the
 * empty config rather than blanking the page (L-39 acceptance criterion) —
 * the exact same contract saved_views' decodeStoredConfig gives
 * `saved_views.config` (web/src/lib/views/view-config.ts).
 */
export function decodePreferencesConfig(raw: unknown): PreferencesConfig {
  if (raw === null || raw === undefined) return emptyPreferencesConfig();
  const parsed = preferencesConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyPreferencesConfig();
}

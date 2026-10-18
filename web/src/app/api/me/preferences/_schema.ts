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

/**
 * Navigation (R-78 progressive disclosure; shortcuts added UI/UX Wave 6).
 *   { mode?: "essentials" | "all", shortcuts?: string[] }
 * "essentials" shows the 7-item core sidebar; "all" shows every module.
 * The cookie (per device) is the first-paint source of truth; this DB
 * mirror lets a signed-in non-demo user's choice follow the account.
 * `shortcuts` is the mobile bottom-bar's pinned destinations, as in-app
 * paths ("/risks"), in display order. Capped well above the bar's 4 slots so
 * a future layout change needs no schema change; unknown paths are dropped
 * client-side against the live nav list, never trusted for routing.
 */
const navShortcutSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^\/[a-z0-9][a-z0-9/-]*$/, "shortcuts must be in-app paths like /risks");

const navSchema = z.object({
  mode: z.enum(["essentials", "all"]).optional(),
  shortcuts: z.array(navShortcutSchema).max(8).optional(),
});

/**
 * Page hints (R-78) — one-line "what is this page for" strips, dismissed
 * per page id. Capped at 40 ids (there are ~25 console pages).
 */
const hintsSchema = z.object({
  dismissed: z.array(z.string().min(1).max(64)).max(40).optional(),
});

/**
 * Getting-started checklist (R-78) — the /start page's dismiss flag plus
 * the ids of read-only steps the user has clicked through (steps that can't
 * be derived from workspace data, e.g. "read the audit trail").
 */
const startSchema = z.object({
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
  nav: navSchema.optional(),
  hints: hintsSchema.optional(),
  start: startSchema.optional(),
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
 * Merge an incoming (partial) config onto the existing stored config for a
 * merge-upsert PUT (L-39). Two callers — first-run-wizard.tsx and
 * governance-tour.tsx — legitimately PUT only ONE top-level key each
 * (`{ config: { onboarding } }` / `{ config: { tour } }`); a naive
 * verbatim-replace upsert (the old behaviour) silently wiped every other
 * saved key (columns, groupBy, density, dateDisplay, defaultLanding) any
 * time either component dismissed. Semantics:
 *
 *   - top-level keys present in `incoming` OVERRIDE the same key in
 *     `existing`; a key absent from `incoming` is PRESERVED from `existing`.
 *   - `columns` and `groupBy` are record-shaped (per-register), so they
 *     merge one level deeper: a register key present in the incoming record
 *     overrides that register's value, other registers already saved on
 *     `existing` are preserved untouched.
 *   - every other key (`density`, `dateDisplay`, `defaultLanding`,
 *     `onboarding`, `tour`) is replaced whole when present in `incoming` —
 *     no deeper merge (e.g. a partial `{ onboarding: { step: 3 } }` REPLACES
 *     the whole stored `onboarding` object, it does not merge into it; each
 *     caller already sends its own complete object for the key it owns).
 *
 * There is deliberately no protocol for DELETING a previously-saved key
 * (e.g. clearing `defaultLanding` back to "unset") — every current caller
 * only ever adds/replaces keys, never removes one. An explicit-null /
 * tombstone convention for deletion is out of scope for this fix; add one
 * if a future caller needs it.
 */
export function mergePreferencesConfig(
  existing: PreferencesConfig,
  incoming: PreferencesConfig,
): PreferencesConfig {
  const merged: PreferencesConfig = { ...existing, ...incoming };

  if (existing.columns || incoming.columns) {
    merged.columns = { ...existing.columns, ...incoming.columns };
  }
  if (existing.groupBy || incoming.groupBy) {
    merged.groupBy = { ...existing.groupBy, ...incoming.groupBy };
  }
  // `nav` carries two independent owners (the sidebar's `mode`, the bottom
  // bar's `shortcuts`) — merge one level deeper so neither clobbers the other.
  if (existing.nav || incoming.nav) {
    merged.nav = { ...existing.nav, ...incoming.nav };
  }

  return merged;
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

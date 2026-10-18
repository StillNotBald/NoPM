// ── Client-side form validation ──────────────────────────────────────────────
// Pure, dependency-free replacement for the one-field zod ".min(1)" / ".uuid()"
// checks that used to live in web/src/components/forms/*-form.tsx. These forms
// only ever needed "is this required text present" and "is this a UUID" —
// pulling all of zod into the client bundle for that was overkill. Server-side
// validation in the API routes still uses zod; this file is client-only.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mirrors `z.string().min(1, message)`: fails only on an empty string, not on
 * whitespace-only input — matching the zod behaviour this replaces exactly.
 */
export function requireText(value: string, message: string): string | null {
  return value.length > 0 ? null : message;
}

/** Mirrors `z.string().uuid(message)`. */
export function requireUuid(value: string, message: string): string | null {
  return UUID_RE.test(value) ? null : message;
}

export interface FieldRule {
  key: string;
  value: string;
  message: string;
  kind?: "text" | "uuid";
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: Record<string, string> };

/**
 * Runs a list of field rules and collects the first failure per key — the
 * same "first issue per field wins" behaviour as the zod `safeParse` +
 * `issue.path[0]` loop it replaces.
 */
export function validateFields(rules: FieldRule[]): ValidationResult {
  const errors: Record<string, string> = {};
  for (const rule of rules) {
    if (errors[rule.key]) continue;
    const err =
      rule.kind === "uuid"
        ? requireUuid(rule.value, rule.message)
        : requireText(rule.value, rule.message);
    if (err) errors[rule.key] = err;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true };
}

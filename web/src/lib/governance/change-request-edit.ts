/**
 * Which edits to a PENDING change request change what an approver is deciding on.
 *
 * Bait-and-switch (Lark red-team): a requester raised a change request, the
 * approval card went out to the approvers' chat, the requester then edited the
 * request (a bigger cost, a different scope), and the approver's tap on the
 * ORIGINAL card approved the NEW content. Two defences, both keyed on this list:
 *   - the PATCH route tells the integration hub when a material field changed,
 *     so the old card is retired and a fresh one carrying the current content
 *     is issued (`updated_at` — bumped by the table's trigger on every edit — is
 *     the content version);
 *   - a decision can name the version it saw (`expected_updated_at`) and is
 *     refused with 412 if the request moved on.
 *
 * `raised_at` is bookkeeping, not something an approver decides on, so editing
 * it alone re-issues nothing. Everything else the schema accepts is material.
 */
export const MATERIAL_CHANGE_FIELDS = [
  "title",
  "description",
  "category",
  "priority",
  "impact_summary",
  "impact_schedule_days",
  "impact_cost",
  "impact_scope",
  "target_date",
] as const;

const NUMERIC_FIELDS: ReadonlySet<string> = new Set(["impact_schedule_days", "impact_cost"]);
const DATE_FIELDS: ReadonlySet<string> = new Set(["target_date"]);
const JSON_FIELDS: ReadonlySet<string> = new Set(["impact_scope"]);

function comparable(field: string, value: unknown): string | number | null {
  if (value === null || value === undefined || value === "") return null;
  if (NUMERIC_FIELDS.has(field)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : String(value);
  }
  if (DATE_FIELDS.has(field)) return String(value).slice(0, 10);
  if (JSON_FIELDS.has(field)) return Array.isArray(value) && value.length === 0 ? null : JSON.stringify(value);
  return String(value);
}

/**
 * The material fields that `updates` would actually CHANGE on `existing`.
 * A field echoed back with its stored value, or absent from `updates`, is not a change.
 */
export function changedMaterialFields(
  existing: Record<string, unknown>,
  updates: Record<string, unknown>,
): string[] {
  return MATERIAL_CHANGE_FIELDS.filter(
    (field) =>
      Object.prototype.hasOwnProperty.call(updates, field) &&
      updates[field] !== undefined &&
      comparable(field, updates[field]) !== comparable(field, existing[field]),
  );
}

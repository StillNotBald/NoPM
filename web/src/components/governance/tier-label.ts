/**
 * The one place a tier value becomes words. Every screen that shows an approval tier (review queue,
 * Approvals, Change Control list and detail, deletion request rows) goes through this, so a raw value
 * such as `high_risk` is never shown to a person (UAT-036).
 */
export const TIER_LABELS: Record<string, string> = {
  routine: "Routine",
  normal: "Normal",
  high_risk: "High risk",
  emergency: "Emergency",
  strategic: "Strategic",
};

/** Human label for a tier; an unknown value is title-cased with underscores turned into spaces, never shown raw. */
export function tierLabel(tier: string): string {
  const known = TIER_LABELS[tier];
  if (known) return known;
  const words = tier.replace(/_/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : tier;
}

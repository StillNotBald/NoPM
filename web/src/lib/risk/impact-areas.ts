/**
 * The one list of risk impact areas (W1-12). Mirrors the `risk_impact_area` enum in
 * migration 0008; impact-areas.test.ts locks it to that enum and to the copy the plain-JS
 * tool registry (web/mcp/tools.mjs) has to keep.
 */
export const RISK_IMPACT_AREAS = ["schedule", "cost", "scope", "quality", "reputation", "compliance"] as const;

export type RiskImpactAreaValue = (typeof RISK_IMPACT_AREAS)[number];

const cap = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);

/** Display label for an area ("cost" -> "Cost"). */
export function impactAreaLabel(v: string): string {
  return cap(v);
}

/** { value, label } options for selects and checkbox groups. */
export const IMPACT_AREA_OPTIONS: { value: RiskImpactAreaValue; label: string }[] = RISK_IMPACT_AREAS.map((v) => ({
  value: v,
  label: cap(v),
}));

/**
 * lib/review/text.ts
 *
 * One string helper shared by the review gatherer, the pending-approval loader and the
 * deletion-target describer. It lives alone so that client components (inline-action.tsx
 * imports `childCountsHeading` from deletion-target.ts) never pull pending.ts, which reaches
 * the server-only auth guard through deletion-dispatch.ts. See client-server-boundary.test.ts.
 */

/** Flatten whitespace and clip to `max` characters with an ellipsis; null for non-strings and blanks. */
export function clip(value: unknown, max = 160): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

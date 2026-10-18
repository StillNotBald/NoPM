/** Routes retired with hour logging (owner decision 18). Old stored notifications may still point at them. */
const RETIRED_PREFIXES = ["/timesheets", "/time"];

/**
 * Where a stored notification should navigate. Retired timesheet links fall
 * back to /review; an absent href stays absent (the row renders without a link).
 */
export function safeNotificationHref(href: string | undefined | null): string | undefined {
  if (!href) return undefined;
  const path = href.split(/[?#]/)[0].replace(/\/+$/, "");
  if (RETIRED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return "/review";
  return href;
}

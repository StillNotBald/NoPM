/**
 * Accessible text for timeline bars/markers. Dates go through formatByPref
 * so the user's absolute/relative preference is honoured (no hardcoded locale).
 */
import { formatByPref, type DateDisplayPref } from "@/lib/format/dates";
import { slipPhrase } from "./dates";

export function fmtDate(iso: string | null | undefined, pref: DateDisplayPref): string {
  return formatByPref(iso, pref).text;
}

/** "3 Mar 2026 to 14 Mar 2026"; single/absent ends degrade gracefully. */
export function fmtRange(
  start: string | null | undefined,
  end: string | null | undefined,
  pref: DateDisplayPref,
): string {
  if (start && end) return `${fmtDate(start, pref)} to ${fmtDate(end, pref)}`;
  if (end) return `due ${fmtDate(end, pref)}`;
  if (start) return `from ${fmtDate(start, pref)}`;
  return "no dates";
}

export interface BarDescription {
  kind?: string; // "Task", "Milestone", "Project"
  name: string;
  start?: string | null;
  end?: string | null;
  status?: string | null;
  critical?: boolean;
  slip?: number | null;
  progressPct?: number | null;
  pref: DateDisplayPref;
}

/** e.g. "Task X, 3 Mar 2026 to 14 Mar 2026, critical path, slipped 4 days". */
export function describeBar(b: BarDescription): string {
  const parts = [`${b.kind ?? "Task"} ${b.name}`, fmtRange(b.start, b.end, b.pref)];
  if (b.status) parts.push(b.status);
  if (b.progressPct != null) parts.push(`${Math.round(b.progressPct)}% complete`);
  if (b.critical) parts.push("critical path");
  const s = slipPhrase(b.slip ?? null);
  if (s) parts.push(s);
  return parts.join(", ");
}

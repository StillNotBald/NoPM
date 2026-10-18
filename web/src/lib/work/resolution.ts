/** Q-WRK-19 — a risk/issue is closed with a short note on how it was resolved. */
export const RESOLUTION_NOTE_MESSAGE = "Add a short note on how this was resolved.";

export function needsResolutionNote(note: string | null | undefined): boolean {
  return !note || note.trim().length === 0;
}

const LEVELS = ["low", "medium", "high", "critical"] as const;

/** True when `next` is a higher severity/likelihood level than `prev`. */
export function rankIncreased(prev: string | null | undefined, next: string | null | undefined): boolean {
  const a = LEVELS.indexOf((prev ?? "") as (typeof LEVELS)[number]);
  const b = LEVELS.indexOf((next ?? "") as (typeof LEVELS)[number]);
  return a >= 0 && b > a;
}

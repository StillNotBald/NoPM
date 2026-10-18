/**
 * Q-WRK-4 / Q-WRK-5 — sprint timing flags. NoPM never starts or closes a sprint
 * on its own (Jira sprints are started and completed by a person); it only says
 * when a sprint is behind its dates so the person is reminded.
 *
 *   late_to_start : still `planned` although its start date has passed
 *   past_end      : still `active` although its end date has passed
 */
export type SprintTimingFlag = "late_to_start" | "past_end" | null;

type TimedSprint = { state: string; start_date: string; end_date: string };

const KL_OFFSET_MS = 8 * 60 * 60 * 1000; // default workspace time zone (Malaysia)

/** Today's calendar date (YYYY-MM-DD) in the default workspace time zone. */
export function todayInWorkspaceZone(now: Date = new Date()): string {
  return new Date(now.getTime() + KL_OFFSET_MS).toISOString().slice(0, 10);
}

export function sprintTimingFlag(sprint: TimedSprint, today: string = todayInWorkspaceZone()): SprintTimingFlag {
  if (sprint.state === "planned" && sprint.start_date < today) return "late_to_start";
  if (sprint.state === "active" && sprint.end_date < today) return "past_end";
  return null;
}

export function sprintTimingMessage(flag: SprintTimingFlag): string | null {
  if (flag === "late_to_start") return "This sprint was due to start already. Start it, or move its dates.";
  if (flag === "past_end") return "This sprint is past its end date. Close it, or move its end date.";
  return null;
}

export function withTimingFlag<T extends TimedSprint>(sprint: T, today?: string): T & { timing_flag: SprintTimingFlag } {
  return { ...sprint, timing_flag: sprintTimingFlag(sprint, today) };
}

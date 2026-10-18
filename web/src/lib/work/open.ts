/**
 * One definition of "open" for work items, shared by the handover report and
 * the stale-item nudges (wave-3 review F12). An item is open unless its status
 * (or, for a task, its status type) is one of the finished words below,
 * compared case-insensitively. So a backlog task and an accepted risk are open.
 */
export const FINISHED_STATUSES = [
  "done", "canceled", "cancelled", "closed", "resolved", "completed", "withdrawn",
] as const;

const FINISHED = new Set<string>(FINISHED_STATUSES);

/** Pass every status-like value the record has (a task: status_type and status). */
export function isOpenStatus(...values: Array<string | null | undefined>): boolean {
  return !values.some((v) => typeof v === "string" && FINISHED.has(v.trim().toLowerCase()));
}

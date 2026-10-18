/**
 * Q-WRK-20 — closing a sprint asks where the unfinished tasks go (Jira does the
 * same). The choice is `move_unfinished_to`: "backlog" (leave every sprint) or
 * the id of another planned/active sprint of the SAME project. Completed and
 * canceled tasks stay attached to the closed sprint as its history.
 */
export const DONE_STATUS_TYPES = ["completed", "canceled"] as const;

export function isUnfinished(statusType: string | null | undefined): boolean {
  return !(DONE_STATUS_TYPES as readonly string[]).includes(statusType ?? "");
}

export function unfinishedPrompt(count: number): string {
  return `${count} ${count === 1 ? "task is" : "tasks are"} not finished. Choose where ${count === 1 ? "it goes" : "they go"}: "backlog" or another sprint of this project (move_unfinished_to).`;
}

export type CloseDestination = { kind: "backlog" } | { kind: "sprint"; sprintId: string };

export function parseDestination(value: string): CloseDestination {
  return value === "backlog" ? { kind: "backlog" } : { kind: "sprint", sprintId: value };
}

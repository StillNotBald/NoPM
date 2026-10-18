/** Q-WRK-14 — warning shown before a milestone is completed with open tasks. */
export function openTasksMessage(count: number): string {
  return `${count} ${count === 1 ? "task is" : "tasks are"} still open. Complete this milestone anyway?`;
}

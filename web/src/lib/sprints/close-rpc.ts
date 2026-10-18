import { NotFoundError, RuleError } from "@/lib/api/errors";
import { unfinishedPrompt } from "@/lib/sprints/close";

type RpcError = { message?: string | null; code?: string | null };

/**
 * Translate the errcodes of nopm_close_sprint (migration 0086) into typed API
 * errors. Anything unrecognised is rethrown plain (a 500): a real fault is never
 * disguised as a rule violation.
 */
export function throwCloseSprintRpcError(error: RpcError): never {
  const m = `${error.message ?? ""} ${error.code ?? ""}`;
  if (m.includes("NOT_FOUND") || error.code === "P0002") throw new NotFoundError("Sprint not found");
  if (m.includes("SPRINT_NOT_ACTIVE") || error.code === "P0025") throw new RuleError("Sprint must be active to close");
  if (m.includes("UNFINISHED_TASKS") || error.code === "P0026") {
    // A task was attached or reopened after the caller's read.
    throw new RuleError(unfinishedPrompt(1).replace(/^1 task is/, "Tasks are"), "unfinished_tasks");
  }
  if (m.includes("INVALID_DESTINATION") || error.code === "P0027") {
    throw new RuleError(
      "move_unfinished_to must be \"backlog\" or another planned or active sprint of this project",
      "invalid_destination",
    );
  }
  throw new Error(error.message || "Failed to close the sprint");
}

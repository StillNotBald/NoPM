import { RuleError } from "@/lib/api/errors";

/**
 * Four-eyes deletion commit dispatch (devops-wave1b, U2).
 *
 * Each supported `deletion_requests.target_type` has its OWN atomic commit
 * RPC — deliberately NOT a single parameterized function. See migration
 * 20260814000032's header (KNOWN TRAP): nopm_commit_task_deletion (0020)
 * hardcodes both the `tasks` table and the audit action string 'task.delete';
 * nopm_commit_project_deletion (0032) is a dedicated sibling that hardcodes
 * `projects` / 'project.delete'. The audit action string must stay a
 * compile-time-visible literal per entity type inside each function, so this
 * map only ever grows by adding a new sibling RPC + a new entry here — it
 * must never be "generalized" into a runtime-interpolated table/action name.
 *
 * Owner-locked (Decision 3, requirements/devops-wave1/README.md): maker-checker
 * extends to PROJECTS ONLY. Milestones/risks/issues stay audit-only hard-delete
 * (no deletion_requests row is ever created for them), so they intentionally
 * have no entry here.
 */
const DELETION_COMMIT_RPC: Readonly<Record<string, string>> = {
  task: "nopm_commit_task_deletion",
  project: "nopm_commit_project_deletion",
};

/**
 * Resolve the atomic commit RPC name for a `deletion_requests.target_type`.
 * Throws RuleError (422) for any target_type without a wired commit RPC.
 */
export function resolveDeletionCommitRpc(targetType: string): string {
  const rpc = DELETION_COMMIT_RPC[targetType];
  if (!rpc) {
    throw new RuleError(
      `Unsupported deletion target type: ${targetType}`,
      "unsupported_target_type",
    );
  }
  return rpc;
}

/**
 * Per-type scope gates for the deletion-request decision verbs. The checker
 * verbs (approve/reject) and the maker verb (withdraw) must each hold the
 * scope matching the REQUEST'S target type — task:delete:approve does not
 * grant project-deletion approval, and vice versa. Guard symmetry: every
 * decision verb resolves its scope through these, never a hardcoded literal.
 */
const DELETION_APPROVE_SCOPE: Readonly<Record<string, string>> = {
  task: "task:delete:approve",
  project: "project:delete:approve",
};
const DELETION_REQUEST_SCOPE: Readonly<Record<string, string>> = {
  task: "task:delete:request",
  project: "project:delete:request",
};

/** Scope required to approve/reject a request of this target type (422 if unsupported). */
export function resolveDeletionApproveScope(targetType: string): string {
  const scope = DELETION_APPROVE_SCOPE[targetType];
  if (!scope) {
    throw new RuleError(
      `Unsupported deletion target type: ${targetType}`,
      "unsupported_target_type",
    );
  }
  return scope;
}

/** Scope required to withdraw (maker verb) a request of this target type (422 if unsupported). */
export function resolveDeletionRequestScope(targetType: string): string {
  const scope = DELETION_REQUEST_SCOPE[targetType];
  if (!scope) {
    throw new RuleError(
      `Unsupported deletion target type: ${targetType}`,
      "unsupported_target_type",
    );
  }
  return scope;
}

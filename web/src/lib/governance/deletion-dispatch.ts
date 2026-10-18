import { RuleError } from "@/lib/api/errors";
import { requireScope, type Actor } from "@/lib/auth/guard";
import { requestDeleteScopes } from "@/lib/auth/scopes";

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
 * History: Decision 3 (requirements/devops-wave1/README.md) limited maker-checker to
 * tasks and projects. Audit gap G8 (CHANGE-REQUEST assumption A8, migration 0102)
 * extended it to risks, issues, expenses, documents and milestones, each with its own
 * sibling commit RPC (nopm_commit_<entity>_deletion) and a BEFORE DELETE backstop in
 * the database. Clashes and programs are not governed records and stay direct.
 */
const DELETION_COMMIT_RPC: Readonly<Record<string, string>> = {
  task: "nopm_commit_task_deletion",
  project: "nopm_commit_project_deletion",
  risk: "nopm_commit_risk_deletion",
  issue: "nopm_commit_issue_deletion",
  expense: "nopm_commit_expense_deletion",
  document: "nopm_commit_document_deletion",
  milestone: "nopm_commit_milestone_deletion",
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
  risk: "risk:delete:approve",
  issue: "issue:delete:approve",
  expense: "expense:delete:approve",
  document: "document:delete:approve",
  milestone: "milestone:delete:approve",
};
const DELETION_REQUEST_SCOPE: Readonly<Record<string, string>> = {
  task: "task:delete:request",
  project: "project:delete:request",
  risk: "risk:delete:request",
  issue: "issue:delete:request",
  expense: "expense:delete:request",
  document: "document:delete:request",
  milestone: "milestone:delete:request",
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

/**
 * The maker gate for a deletion request of this target type: the new `<entity>:delete:request`
 * scope, or (risks and issues) the wave-1 `<entity>:delete` scope it replaced. Throws 403 naming
 * the new scope when the caller holds neither. Viewers stay read-only (requireScope).
 */
export function requireDeletionRequestScope(actor: Actor, targetType: string): void {
  const accepted = requestDeleteScopes(targetType);
  let first: unknown = null;
  for (const scope of accepted) {
    try {
      requireScope(actor, scope);
      return;
    } catch (err) {
      first ??= err;
    }
  }
  // None matched: report the failure for the modern scope (the first one tried).
  throw first;
}

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
 * the database. Wave 5 (R-176, migrations 0113 and 0114) extended it to programs, sprints, resources
 * (resource_members), allocations and clashes, each with its own sibling commit RPC.
 */
const DELETION_COMMIT_RPC: Readonly<Record<string, string>> = {
  task: "nopm_commit_task_deletion",
  project: "nopm_commit_project_deletion",
  risk: "nopm_commit_risk_deletion",
  issue: "nopm_commit_issue_deletion",
  expense: "nopm_commit_expense_deletion",
  document: "nopm_commit_document_deletion",
  milestone: "nopm_commit_milestone_deletion",
  program: "nopm_commit_program_deletion",
  sprint: "nopm_commit_sprint_deletion",
  resource: "nopm_commit_resource_deletion",
  allocation: "nopm_commit_allocation_deletion",
  clash: "nopm_commit_clash_deletion",
};

/**
 * The five registers that gained deletion-by-request in wave 5 (R-176). Their approval kind strings live HERE and not in
 * @/lib/integrations/types: no chat card is sent for them (the hub's ApprovalKind stays the seven governed records),
 * so announceRequested / announceDecided are skipped for these kinds.
 */
export const REGISTER_DELETION_ENTITIES = ["program", "sprint", "resource", "allocation", "clash"] as const;
export type RegisterDeletionEntity = (typeof REGISTER_DELETION_ENTITIES)[number];
export type RegisterDeletionKind = `${RegisterDeletionEntity}_deletion`;

/** True when this `deletion_requests.target_type` is one of the five wave-5 registers. */
export function isRegisterDeletionTarget(targetType: string): targetType is RegisterDeletionEntity {
  return (REGISTER_DELETION_ENTITIES as readonly string[]).includes(targetType);
}

/** True for "program_deletion", "sprint_deletion", "resource_deletion", "allocation_deletion", "clash_deletion". */
export function isRegisterDeletionKind(kind: string): kind is RegisterDeletionKind {
  return REGISTER_DELETION_ENTITIES.some((e) => `${e}_deletion` === kind);
}

export function registerDeletionKindFor(entity: RegisterDeletionEntity): RegisterDeletionKind {
  return `${entity}_deletion`;
}

/** The `deletion_requests.target_type` of a register kind ("program_deletion" is "program"). */
export function registerEntityOfKind(kind: RegisterDeletionKind): RegisterDeletionEntity {
  return kind.slice(0, -"_deletion".length) as RegisterDeletionEntity;
}

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
  // Wave 5 registers. No new scope names: a program is a group of projects and is approved with the project verb,
  // the other four with the task verb. Both are PRIVILEGED (a wildcard never grants them), so an agent token can
  // approve only when someone deliberately minted it with the exact name. Approval is still limited to an admin or
  // manager of the tier the request carries (a program is high_risk) and never to the requester.
  program: "project:delete:approve",
  sprint: "task:delete:approve",
  resource: "task:delete:approve",
  allocation: "task:delete:approve",
  clash: "task:delete:approve",
};
const DELETION_REQUEST_SCOPE: Readonly<Record<string, string>> = {
  task: "task:delete:request",
  project: "project:delete:request",
  risk: "risk:delete:request",
  issue: "issue:delete:request",
  expense: "expense:delete:request",
  document: "document:delete:request",
  milestone: "milestone:delete:request",
  // Wave 5 registers: the new `<entity>:delete:request` scope (registered in scopes.ts; the agent preset holds none).
  program: "program:delete:request",
  sprint: "sprint:delete:request",
  resource: "resource:delete:request",
  allocation: "allocation:delete:request",
  clash: "clash:delete:request",
};

/**
 * The write scope that could delete a register BEFORE wave 5. A token minted with it keeps the right to ASK (the same
 * backward-compatible alias risk:delete and issue:delete got in 0102); nobody gains the right to approve. Viewers stay
 * read-only (requireScope).
 */
const REGISTER_LEGACY_WRITE_SCOPE: Readonly<Record<RegisterDeletionEntity, string>> = {
  program: "program:write",
  sprint: "sprint:write",
  resource: "resource:write",
  allocation: "resource:write",
  clash: "clash:write",
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
  if (isRegisterDeletionTarget(targetType)) {
    try {
      requireScope(actor, DELETION_REQUEST_SCOPE[targetType]);
    } catch (err) {
      try {
        requireScope(actor, REGISTER_LEGACY_WRITE_SCOPE[targetType]);
      } catch {
        throw err; // report the failure for the modern scope
      }
    }
    return;
  }
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

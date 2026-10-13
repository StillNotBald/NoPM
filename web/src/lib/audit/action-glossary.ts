/**
 * Audit action glossary: every `audit_log.action` value NoPM can write, with a
 * plain-language description. Shown in the Trust Center sidebar and used for
 * the action filter suggestions.
 *
 * Drift guard: `action-glossary.test.ts` scans every `writeAudit(...)` call
 * site, the saved-view action resolver and the SQL migrations that insert
 * into audit_log, and fails if an action is written but missing here (or
 * listed here but never written). Add new actions here in the same commit.
 */

export interface AuditActionEntry {
  action: string;
  description: string;
}

export const AUDIT_ACTION_GLOSSARY: readonly AuditActionEntry[] = [
  // Tasks and dependencies
  { action: "task.create", description: "A task was created" },
  { action: "task.create.blocked", description: "Task creation refused by a governance rule" },
  { action: "task.update", description: "A task field was changed" },
  { action: "task.update.blocked", description: "Task change refused by a governance rule" },
  { action: "task.delete_requested", description: "Task deletion requested (awaits a second approver)" },
  { action: "task.delete_request.blocked", description: "Task deletion request refused by a rule" },
  { action: "task.delete", description: "Task hard-deleted after approval" },
  { action: "task_dependency.create", description: "A task dependency was added" },
  { action: "task_dependency.delete", description: "A task dependency was removed" },
  { action: "dependency.create.blocked", description: "Dependency creation refused (e.g. cycle or lock)" },
  { action: "dependency.delete.blocked", description: "Dependency removal refused by a rule" },
  // Deletion requests (maker-checker)
  { action: "deletion_request.approved", description: "A second reviewer approved the deletion" },
  { action: "deletion_request.rejected", description: "A second reviewer rejected the deletion" },
  { action: "deletion_request.withdrawn", description: "The requester withdrew their own request" },
  // Projects, programs, milestones
  { action: "project.create", description: "A project was created" },
  { action: "project.update", description: "Project metadata was updated" },
  { action: "project.lock", description: "Project schedule baseline locked" },
  { action: "project.unlock", description: "Project schedule baseline unlocked" },
  { action: "project.delete_requested", description: "Project deletion requested (awaits a second approver)" },
  { action: "project.delete", description: "Project hard-deleted after approval" },
  { action: "program.create", description: "A program was created" },
  { action: "program.update", description: "A program was updated" },
  { action: "program.delete", description: "A program was deleted" },
  { action: "milestone.create", description: "A milestone was created" },
  { action: "milestone.create.blocked", description: "Milestone creation refused by a rule" },
  { action: "milestone.update", description: "A milestone was updated" },
  { action: "milestone.update.blocked", description: "Milestone change refused by a rule" },
  { action: "milestone.delete", description: "A milestone was deleted" },
  { action: "milestone.delete.blocked", description: "Milestone deletion refused by a rule" },
  // Rebaseline and change control
  { action: "rebaseline.create", description: "A rebaseline was proposed" },
  { action: "rebaseline.signoff", description: "A rebaseline was signed off" },
  { action: "rebaseline.apply", description: "A rebaseline was applied to the plan" },
  { action: "change_request.create", description: "A change request was raised" },
  { action: "change_request.update", description: "A change request was edited" },
  { action: "change_request.decide", description: "A change request was approved or rejected" },
  { action: "change_request.delete", description: "A change request was deleted" },
  // Registers
  { action: "risk.create", description: "A risk was logged" },
  { action: "risk.update", description: "A risk was updated" },
  { action: "risk.delete", description: "A risk was deleted" },
  { action: "issue.create", description: "An issue was logged" },
  { action: "issue.update", description: "An issue was updated" },
  { action: "issue.delete", description: "An issue was deleted" },
  { action: "decision.create", description: "A decision was recorded" },
  { action: "decision.update", description: "A decision was updated" },
  { action: "decision.delete", description: "A decision was deleted" },
  { action: "document.create", description: "A document record was created" },
  { action: "document.update", description: "A document record was updated" },
  { action: "document.delete", description: "A document record was deleted" },
  { action: "document.file.attach", description: "A file was attached to a document" },
  { action: "document.file.remove", description: "A file was removed from a document" },
  { action: "clash.create", description: "A clash was logged manually" },
  { action: "clash.auto_detected", description: "A clash was detected automatically" },
  { action: "clash.update", description: "A clash was updated" },
  { action: "clash.delete", description: "A clash was deleted" },
  // Resources, time, budget
  { action: "resource.create", description: "A resource was added" },
  { action: "resource.update", description: "A resource was updated" },
  { action: "resource.delete", description: "A resource was removed" },
  { action: "allocation.create", description: "A resource allocation was created" },
  { action: "allocation.update", description: "A resource allocation was changed" },
  { action: "allocation.delete", description: "A resource allocation was removed" },
  { action: "time.create", description: "A time entry was logged" },
  { action: "time.delete", description: "A time entry was deleted" },
  { action: "timesheet.submitted", description: "A timesheet was submitted" },
  { action: "expense.create", description: "An expense was recorded" },
  { action: "expense.delete", description: "An expense was deleted" },
  { action: "budget.update", description: "A project budget was changed" },
  // Sprints and saved views
  { action: "sprint.create", description: "A sprint was created" },
  { action: "sprint.update", description: "A sprint was updated" },
  { action: "sprint.delete", description: "A sprint was deleted" },
  { action: "sprint.started", description: "A sprint was started" },
  { action: "sprint.closed", description: "A sprint was closed" },
  { action: "sprint.task_added", description: "A task was added to a sprint" },
  { action: "sprint.task_removed", description: "A task was removed from a sprint" },
  { action: "saved_view.create", description: "A saved view was created" },
  { action: "saved_view.update", description: "A saved view was edited" },
  { action: "saved_view.shared", description: "A saved view's sharing scope changed" },
  { action: "saved_view.protected", description: "A saved view's protected flag changed" },
  { action: "saved_view.delete", description: "A saved view was deleted" },
  // Access, identity, platform
  { action: "token.create", description: "A personal access token was issued" },
  { action: "token.revoke", description: "A personal access token was revoked" },
  { action: "invite.created", description: "A workspace invite was sent" },
  { action: "invite.revoked", description: "A workspace invite was revoked" },
  { action: "invite.accepted", description: "A workspace invite was accepted" },
  { action: "member.joined", description: "A member joined the workspace" },
  { action: "profile.update", description: "A user profile was updated" },
  { action: "mfa.enroll_started", description: "Two-factor enrolment started" },
  { action: "mfa.enabled", description: "Two-factor authentication enabled" },
  { action: "mfa.disabled", description: "Two-factor authentication disabled" },
  { action: "auth.mfa.challenge_passed", description: "A two-factor challenge was passed" },
  { action: "auth.mfa.challenge_failed", description: "A two-factor challenge failed" },
  { action: "assistant.credential.set", description: "An assistant API key was stored (encrypted)" },
  { action: "assistant.credential.revoke", description: "An assistant API key was removed" },
  { action: "export.csv", description: "A CSV export was generated" },
  { action: "rate.limited", description: "A caller was rate limited" },
];

const DESCRIPTIONS = new Map(AUDIT_ACTION_GLOSSARY.map((e) => [e.action, e.description]));

/** Plain-language description for an action, or undefined if unknown. */
export function describeAuditAction(action: string): string | undefined {
  return DESCRIPTIONS.get(action);
}

import { NextResponse } from "next/server";
import { z } from "zod";
import type { Actor } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { safeJson, validationError } from "@/lib/api/response";
import { writeAudit } from "@/lib/audit/write";
import { assignedApproverIdField, resolveAssignedApprover } from "@/lib/review/assignee";
import { notify, resolveWorkspaceApprovers } from "@/lib/notify/publish";
import { actorLabel, announceRequested, projectNameOf, requireMakerPrincipal } from "@/lib/governance/decide";
import { requireDeletionRequestScope } from "@/lib/governance/deletion-dispatch";
import { assertProjectUnlocked } from "@/lib/governance/lock";
import { deletionKindFor } from "@/lib/integrations/types";
import { requestDeletionAtomic } from "@/lib/governance/atomic-rpc";
import { approverRoleFor, classify, deadlineFor, humanRoleOf, loadApprovalPolicy } from "@/lib/governance/tiers";

/**
 * The maker step of deletion-by-request for the five records that used to be hard-deleted
 * directly (audit gap G8, migration 0102): risks, issues, expenses, documents and milestones.
 * Tasks and projects keep their own handlers; they were built first and carry extras
 * (task edit-binding, the project child-count fingerprint).
 *
 * `DELETE /api/<entity>/:id` calls requestDeletion() and returns its 202. Nothing is deleted:
 * a `deletion_requests` row is inserted, the request is audited (`<entity>.delete_requested`),
 * approvers are notified and the chat hub is told. A second person approves through
 * POST /api/deletion-requests/:id/approve, which runs the matching commit RPC
 * (nopm_commit_<entity>_deletion). The database refuses any other DELETE on these tables.
 *
 * The audit action strings below are written out per entity (not built from a variable) so a
 * search for "risk.delete_requested" finds the line that writes it.
 */
export const REQUESTABLE_ENTITIES = ["risk", "issue", "expense", "document", "milestone"] as const;
export type RequestableEntity = (typeof REQUESTABLE_ENTITIES)[number];

const TABLE: Record<RequestableEntity, string> = {
  risk: "risks",
  issue: "issues",
  expense: "expenses",
  document: "documents",
  milestone: "milestones",
};

const NOUN: Record<RequestableEntity, string> = {
  risk: "risk",
  issue: "issue",
  expense: "expense",
  document: "document",
  milestone: "milestone",
};

// One constant per audit action, so the drift guard (action-glossary.test.ts) and a text search both find them.
const RISK_REQUESTED_AUDIT_ACTION = "risk.delete_requested";
const ISSUE_REQUESTED_AUDIT_ACTION = "issue.delete_requested";
const EXPENSE_REQUESTED_AUDIT_ACTION = "expense.delete_requested";
const DOCUMENT_REQUESTED_AUDIT_ACTION = "document.delete_requested";
const MILESTONE_REQUESTED_AUDIT_ACTION = "milestone.delete_requested";
const MILESTONE_BLOCKED_AUDIT_ACTION = "milestone.delete_request.blocked";

const REQUESTED_ACTION: Record<RequestableEntity, string> = {
  risk: RISK_REQUESTED_AUDIT_ACTION,
  issue: ISSUE_REQUESTED_AUDIT_ACTION,
  expense: EXPENSE_REQUESTED_AUDIT_ACTION,
  document: DOCUMENT_REQUESTED_AUDIT_ACTION,
  milestone: MILESTONE_REQUESTED_AUDIT_ACTION,
};

export const DeletionRequestBodySchema = z.object({
  reason: z.string().trim().min(1, "reason is required").max(1000),
  // G5: optional named approver (an admin or manager of the workspace, not the requester).
  assigned_approver_id: assignedApproverIdField,
});

type Row = Record<string, unknown>;

function labelOf(entity: RequestableEntity, row: Row, id: string): string {
  const v = entity === "risk" || entity === "issue" || entity === "document" ? row.title : row.name ?? row.title ?? row.description;
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : id;
}

export async function requestDeletion(args: {
  actor: Actor;
  request: Request;
  entity: RequestableEntity;
  id: string;
}): Promise<NextResponse> {
  const { actor, request, entity, id } = args;
  requireDeletionRequestScope(actor, entity);
  // A token with no recorded owner can't raise the request (R1/H3): its requester principal would
  // be null, so the same person could then approve it from a normal session.
  const requesterPrincipal = requireMakerPrincipal(actor);

  const db = createAdminClient();
  const { data: target, error: fetchError } = await db
    .from(TABLE[entity])
    .select("*")
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!target) throw new NotFoundError(`${capitalise(NOUN[entity])} not found`);
  const row = target as Row;
  const projectId = typeof row.project_id === "string" ? row.project_id : null;

  // A milestone leaves the schedule: refused while the parent project's baseline is frozen.
  if (entity === "milestone" && projectId) {
    await assertProjectUnlocked(db, projectId, actor.workspaceId, () =>
      writeAudit({
        workspaceId: actor.workspaceId,
        actor,
        action: MILESTONE_BLOCKED_AUDIT_ACTION,
        targetType: entity,
        targetId: id,
        before: null,
        after: { reason: "project_locked", project_id: projectId },
      }),
    );
  }

  const duplicate = () =>
    new RuleError(`A pending deletion request already exists for this ${NOUN[entity]}`, "duplicate_deletion_request");

  const { data: existingRequest } = await db
    .from("deletion_requests")
    .select("id")
    .eq("workspace_id", actor.workspaceId)
    .eq("target_type", entity)
    .eq("target_id", id)
    .eq("status", "pending")
    .maybeSingle();
  if (existingRequest) throw duplicate();

  const body = await safeJson(request);
  const parsed = DeletionRequestBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }
  const { reason } = parsed.data;
  // G1/G3: the tier comes from the policy, never from the caller. Owner decision Q4: an approved document is
  // deleted on the manager tier like any other document (the audit trail tracks it, no admin gate). Q5: an
  // expense whose amount reaches the currency threshold is high_risk, like a project.
  const policy = await loadApprovalPolicy(db, actor.workspaceId);
  const { tier } = classify({
    kind: entity === "expense" ? "expense_deletion" : "task_deletion",
    amount: entity === "expense" ? Number(row.amount ?? 0) : undefined,
    requester_role: humanRoleOf(actor as Parameters<typeof humanRoleOf>[0]),
    policy,
  });
  const deadline = deadlineFor(tier, policy, new Date());
  const assignedApproverId = await resolveAssignedApprover(
    db,
    actor.workspaceId,
    parsed.data.assigned_approver_id,
    requesterPrincipal,
    approverRoleFor(tier, policy),
  );

  // The deletion_requests row, its <entity>.delete_requested audit row and the deadline_set event are written by one
  // database function in one transaction (wave 5, R-162). The same function takes the snapshot the approver signs
  // off: the row itself, plus (milestones) how many tasks it detaches; the commit RPC refuses the approval if that
  // count moved, so the approver never signs off on a different scope. uniq_pending_deletion answers a racing request.
  const deletionRequest = await requestDeletionAtomic(db, {
    actor,
    entity,
    action: REQUESTED_ACTION[entity],
    targetId: id,
    reason,
    tier,
    deadline,
    assignedApproverId,
    requesterPrincipal,
  });

  const label = labelOf(entity, row, id);

  // Notify approvers: fail-soft, never throws.
  void resolveWorkspaceApprovers(actor.workspaceId, { tier, assignedApproverId }).then((approverIds) =>
    notify({
      workspaceId: actor.workspaceId,
      recipientIds: approverIds,
      type: "approval.requested",
      title: `Deletion request: ${NOUN[entity]} "${label}"`,
      body: reason,
      payload: { href: "/approvals", targetType: entity, targetId: id, requestId: deletionRequest.id },
    }),
  );

  // Tell the integration hub (chat approval cards): never throws, runs after the request and its audit row exist.
  announceRequested({
    workspaceId: actor.workspaceId,
    kind: deletionKindFor(entity),
    id: deletionRequest.id,
    title: `Delete ${NOUN[entity]} "${label}"`,
    summary: reason,
    projectId,
    projectName: await projectNameOf(db, actor.workspaceId, projectId),
    requestedByLabel: actorLabel(actor),
    requesterPrincipalId: requesterPrincipal,
    tier,
    ...(assignedApproverId ? { assignedApproverId } : {}),
  });

  return NextResponse.json({ data: deletionRequest }, { status: 202 });
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

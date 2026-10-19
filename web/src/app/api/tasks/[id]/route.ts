import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { checkOptimisticConcurrency } from "@/lib/api/occ";
import { writeAudit } from "@/lib/audit/write";
import { auditedUpdate } from "@/lib/audit/audited-write";
import { TaskUpdateSchema, TaskDeleteRequestSchema } from "@/app/api/tasks/_schema";
import { resolveAssignedApprover } from "@/lib/review/assignee";
import { notify, resolveWorkspaceApprovers } from "@/lib/notify/publish";
import { approverRoleFor, classify, deadlineFor, humanRoleOf, loadApprovalPolicy } from "@/lib/governance/tiers";
import { actorLabel, announceRequested, projectNameOf, requireMakerPrincipal } from "@/lib/governance/decide";
import { requestDeletionAtomic } from "@/lib/governance/atomic-rpc";
import { assertProjectUnlocked, changedScheduleShapeFields, SCHEDULE_SHAPE_TASK_FIELDS } from "@/lib/governance/lock";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";
import { assertTaskBackupDiffers, effective } from "@/lib/handover/backup";
import { unknownFieldsResponse } from "@/lib/work/unknown-fields";

export const runtime = "nodejs";

/** GET /api/tasks/[id] — fetch a single task */
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "task:read");

  const db = createAdminClient();
  const { data: task, error } = await db
    .from("tasks")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!task) throw new NotFoundError("Task not found");

  return ok(task);
});

/** PATCH /api/tasks/[id] — update a task (incl. Kanban moves via status_type change) */
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "task:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("tasks")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Task not found");

  const body = await safeJson(request);
  // Strip id and workspace_id from body regardless
  const safe = body && typeof body === "object" ? { ...(body as Record<string, unknown>) } : {};
  delete safe.id;
  delete safe.workspace_id;
  delete safe.project_id; // project cannot be changed after creation

  const unknown = unknownFieldsResponse(safe, TaskUpdateSchema);
  if (unknown) return unknown;
  const parsed = TaskUpdateSchema.safeParse(safe);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    }));
    return validationError("Validation failed", fields);
  }

  const input = parsed.data;

  // Optimistic concurrency (R-90) — opt-in via expected_updated_at. No-op when
  // the caller doesn't send it (today's last-write-wins, unchanged).
  const { expected_updated_at, ...fields } = input;
  checkOptimisticConcurrency(existing.updated_at, expected_updated_at);

  // Schedule-shape CHANGES (dates, estimate, milestone re-assignment) are
  // blocked while the parent project is locked; status/checklist/assignee/etc
  // stay live so day-to-day work continues under a frozen baseline. Only a real
  // value change counts — the DB trigger (0028) and the project route compare
  // values too, so a form that echoes the whole record back is not blocked.
  const frozenFields = changedScheduleShapeFields(fields, existing, SCHEDULE_SHAPE_TASK_FIELDS);
  if (frozenFields.length > 0) {
    await assertProjectUnlocked(db, existing.project_id, actor.workspaceId, () =>
      writeAudit({
        workspaceId: actor.workspaceId,
        actor,
        action: "task.update.blocked",
        targetType: "task",
        targetId: params.id,
        before: null,
        after: { reason: "project_locked", project_id: existing.project_id, fields: frozenFields },
      }),
    );
  }

  // Cross-tenant guard: assignee (resource_member) and blocker (task) must be
  // in THIS workspace. null clears the reference and is always allowed.
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "resource_members", id: input.assignee_id, field: "assignee_id" },
    { table: "resource_members", id: input.backup_assignee_id, field: "backup_assignee_id" },
    { table: "tasks", id: input.blocked_by, field: "blocked_by" },
  ]);

  // M6: a backup is somebody else than the assignee (checked on the values the row will have).
  await assertTaskBackupDiffers(
    db,
    actor.workspaceId,
    effective(input.assignee_id, existing.assignee_id),
    effective(input.backup_assignee_id, existing.backup_assignee_id),
  );

  // If milestone_id is being changed, validate it belongs to the same project + workspace
  if (input.milestone_id !== undefined && input.milestone_id !== null) {
    const { data: milestone } = await db
      .from("milestones")
      .select("id")
      .eq("id", input.milestone_id)
      .eq("workspace_id", actor.workspaceId)
      .eq("project_id", existing.project_id)
      .maybeSingle();
    if (!milestone) throw new NotFoundError("Milestone not found in this project");
  }

  // Row and audit row are one transaction (nopm_mutate_audited). Passing the
  // pre-check updated_at closes the race between the fetch above and the write:
  // on a lost race the RPC answers STALE_ROW, which is the same 412.
  const { after: updated } = await auditedUpdate({
    table: "tasks",
    actor,
    action: "task.update",
    id: params.id,
    patch: { ...fields, updated_at: new Date().toISOString() },
    expectedUpdatedAt: expected_updated_at !== undefined ? existing.updated_at : null,
    notFoundMessage: "Task not found",
  });

  return ok(updated);
});

// One constant per audit action (see request-deletion.ts): a text search for the action finds the line that writes it.
const TASK_REQUESTED_AUDIT_ACTION = "task.delete_requested";

/**
 * DELETE /api/tasks/[id] — does NOT delete the task.
 * Requires scope task:delete:request.
 * Inserts a deletion_requests row and returns 202.
 * If a pending request already exists, returns RuleError (422).
 */
export const DELETE = route(async ({ actor, params, request }) => {
  requireScope(actor, "task:delete:request");
  // A token with no recorded owner can't raise the request (R1/H3): its
  // requester principal would be null, comparable to nobody, so the same
  // person could then approve it from a normal session.
  const requesterPrincipal = requireMakerPrincipal(actor);

  const db = createAdminClient();

  // Fetch the task (must belong to this workspace)
  const { data: task, error: fetchError } = await db
    .from("tasks")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!task) throw new NotFoundError("Task not found");

  // A delete-request removes the task from the schedule — always blocked
  // while the parent project's baseline is frozen.
  await assertProjectUnlocked(db, task.project_id, actor.workspaceId, () =>
    writeAudit({
      workspaceId: actor.workspaceId,
      actor,
      action: "task.delete_request.blocked",
      targetType: "task",
      targetId: params.id,
      before: null,
      after: { reason: "project_locked", project_id: task.project_id },
    }),
  );

  // Check for an existing pending deletion request for this task
  const { data: existingRequest } = await db
    .from("deletion_requests")
    .select("id")
    .eq("workspace_id", actor.workspaceId)
    .eq("target_type", "task")
    .eq("target_id", params.id)
    .eq("status", "pending")
    .maybeSingle();

  if (existingRequest) {
    throw new RuleError(
      "A pending deletion request already exists for this task",
      "duplicate_deletion_request",
    );
  }

  const body = await safeJson(request);
  const parsed = TaskDeleteRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const fields = parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    }));
    return validationError("Validation failed", fields);
  }

  const { reason } = parsed.data;
  // G1: the tier comes from the policy (a project deletion starts at high_risk), never from the caller.
  const policy = await loadApprovalPolicy(db, actor.workspaceId);
  const { tier } = classify({
    kind: "task_deletion",
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

  // The request row, its task.delete_requested audit row and the deadline_set event are written by one database
  // function in one transaction (wave 5, R-162); uniq_pending_deletion answers a racing second request.
  const deletionRequest = await requestDeletionAtomic(db, {
    actor,
    entity: "task",
    action: TASK_REQUESTED_AUDIT_ACTION,
    targetId: params.id,
    reason,
    tier,
    deadline,
    assignedApproverId,
    requesterPrincipal,
  });

  // Notify approvers of THIS tier (G2) — fail-soft (never throws)
  void resolveWorkspaceApprovers(actor.workspaceId, { tier, assignedApproverId }).then((approverIds) => {
    return notify({
      workspaceId: actor.workspaceId,
      recipientIds: approverIds,
      type: "approval.requested",
      title: `Deletion request: task "${task.name ?? params.id}"`,
      body: reason ?? undefined,
      payload: { href: "/approvals", taskId: params.id, requestId: deletionRequest.id },
    });
  });

  // Tell the integration hub (chat approval cards) — never throws, runs after
  // the request and its audit row are committed.
  announceRequested({
    workspaceId: actor.workspaceId,
    kind: "task_deletion",
    id: deletionRequest.id,
    title: `Delete task "${task.name ?? params.id}"`,
    summary: reason ?? null,
    projectId: task.project_id ?? null,
    projectName: await projectNameOf(db, actor.workspaceId, task.project_id),
    requestedByLabel: actorLabel(actor),
    requesterPrincipalId: requesterPrincipal,
    tier,
    ...(assignedApproverId ? { assignedApproverId } : {}),
  });

  // Return 202 Accepted with the deletion_request
  return NextResponse.json({ data: deletionRequest }, { status: 202 });
});

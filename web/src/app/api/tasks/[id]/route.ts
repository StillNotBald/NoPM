import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, PreconditionFailedError, RuleError } from "@/lib/api/errors";
import { checkOptimisticConcurrency } from "@/lib/api/occ";
import { writeAudit } from "@/lib/audit/write";
import { TaskUpdateSchema, TaskDeleteRequestSchema } from "@/app/api/tasks/_schema";
import { notify, resolveWorkspaceApprovers } from "@/lib/notify/publish";
import { actorLabel, announceRequested, projectNameOf, requireMakerPrincipal } from "@/lib/governance/decide";
import { assertProjectUnlocked, changedScheduleShapeFields, SCHEDULE_SHAPE_TASK_FIELDS } from "@/lib/governance/lock";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";
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
    { table: "tasks", id: input.blocked_by, field: "blocked_by" },
  ]);

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

  let query = db
    .from("tasks")
    .update({
      ...fields,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);
  // Defense-in-depth: also scope the write itself to the row's pre-check
  // updated_at, closing the (narrow) race between the fetch above and this
  // write. On a lost race the row exists but the filter matches zero rows —
  // maybeSingle() returns null instead of PostgREST's "no rows" error.
  if (expected_updated_at !== undefined) {
    query = query.eq("updated_at", existing.updated_at);
  }
  const { data: updated, error: updateError } = await query.select().maybeSingle();

  if (updateError) throw new Error(updateError.message);
  if (!updated) {
    if (expected_updated_at !== undefined) {
      throw new PreconditionFailedError("Record changed since you loaded it");
    }
    throw new Error("Update failed");
  }

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "task.update",
    targetType: "task",
    targetId: updated.id,
    before: existing,
    after: updated,
  });

  return ok(updated);
});

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

  const { data: deletionRequest, error: insertError } = await db
    .from("deletion_requests")
    .insert({
      workspace_id: actor.workspaceId,
      target_type: "task",
      target_id: params.id,
      reason,
      status: "pending",
      requested_by_type: actor.type,
      requested_by_id: actor.id,
      requested_by_label: actor.label,
      // The HUMAN behind the requester (the user, or the token's creator) —
      // four-eyes compares this, not the actor id. Never null: an ownerless
      // token was refused above.
      requested_principal_id: requesterPrincipal,
      before: task,
    })
    .select()
    .single();

  // Two concurrent requests both pass the pre-check above; the partial unique
  // index uniq_pending_deletion lets one win and refuses the other (23505) —
  // the same clean 422 as the pre-check, not a raw 500.
  if (insertError?.code === "23505") {
    throw new RuleError(
      "A pending deletion request already exists for this task",
      "duplicate_deletion_request",
    );
  }
  if (insertError || !deletionRequest) {
    throw new Error(insertError?.message ?? "Failed to create deletion request");
  }

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "task.delete_requested",
    targetType: "task",
    targetId: params.id,
    before: task,
    after: null,
  });

  // Notify approvers — fail-soft (never throws)
  void resolveWorkspaceApprovers(actor.workspaceId).then((approverIds) => {
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
  });

  // Return 202 Accepted with the deletion_request
  return NextResponse.json({ data: deletionRequest }, { status: 202 });
});

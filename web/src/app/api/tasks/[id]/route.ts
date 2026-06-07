import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit/write";
import { TaskUpdateSchema, TaskDeleteRequestSchema } from "@/app/api/tasks/_schema";

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

  const parsed = TaskUpdateSchema.safeParse(safe);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    }));
    return validationError("Validation failed", fields);
  }

  const input = parsed.data;

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

  const { data: updated, error: updateError } = await db
    .from("tasks")
    .update({
      ...input,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError || !updated) throw new Error(updateError?.message ?? "Update failed");

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
      before: task,
    })
    .select()
    .single();

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

  // Return 202 Accepted with the deletion_request
  return NextResponse.json({ data: deletionRequest }, { status: 202 });
});

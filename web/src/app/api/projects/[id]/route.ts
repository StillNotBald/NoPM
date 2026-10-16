import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { NextResponse } from "next/server";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, PreconditionFailedError, RuleError } from "@/lib/api/errors";
import { checkOptimisticConcurrency } from "@/lib/api/occ";
import { notify, resolveWorkspaceApprovers } from "@/lib/notify/publish";
import { actorLabel, announceRequested, principalOf } from "@/lib/governance/decide";
import { assertProjectUnlocked } from "@/lib/governance/lock";
import { updateProjectSchema, ProjectDeleteRequestSchema } from "../_schema";

export const runtime = "nodejs";

// GET /api/projects/[id] — fetch a single project (project:read)
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "project:read");

  const db = createAdminClient();
  const { data, error } = await db
    .from("projects")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new NotFoundError("Project not found");

  return ok(data);
});

// PATCH /api/projects/[id] — partial update (project:write)
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "project:write");

  const db = createAdminClient();

  // Fetch the existing row first for before snapshot + workspace guard
  const { data: before, error: fetchError } = await db
    .from("projects")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!before) throw new NotFoundError("Project not found");

  const body = await safeJson(request);
  const parsed = updateProjectSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid project data",
      parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    );
  }

  // Optimistic concurrency (R-90) — opt-in via expected_updated_at. No-op when
  // the caller doesn't send it (today's last-write-wins, unchanged).
  const { expected_updated_at, ...fields } = parsed.data;
  checkOptimisticConcurrency(before.updated_at, expected_updated_at);

  const now = new Date().toISOString();
  let query = db
    .from("projects")
    .update({
      ...fields,
      workspace_id: actor.workspaceId, // never let caller overwrite
      updated_at: now,
    })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);
  // Defense-in-depth: also scope the write itself to the row's pre-check
  // updated_at, closing the (narrow) race between the fetch above and this
  // write. On a lost race the row exists but the filter matches zero rows —
  // maybeSingle() returns null instead of PostgREST's "no rows" error.
  if (expected_updated_at !== undefined) {
    query = query.eq("updated_at", before.updated_at);
  }
  const { data: after, error: updateError } = await query.select().maybeSingle();

  if (updateError) throw updateError;
  if (!after) {
    if (expected_updated_at !== undefined) {
      throw new PreconditionFailedError("Record changed since you loaded it");
    }
    throw new Error("Update failed");
  }

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "project.update",
    targetType: "project",
    targetId: params.id,
    before,
    after,
  });

  return ok(after);
});

/**
 * DELETE /api/projects/[id] — does NOT delete the project.
 * Maker step of the project-deletion four-eyes flow (Decision 3, devops-wave1
 * — maker-checker extends to PROJECTS ONLY; milestones/risks/issues stay
 * audit-only hard-delete). Mirrors the task maker step (see
 * web/src/app/api/tasks/[id]/route.ts DELETE) exactly: requires scope
 * project:delete:request, requires a `reason` in the body, snapshots the
 * project row, inserts a deletion_requests row (target_type='project',
 * status='pending' — uniq_pending_deletion dedupes concurrent requests for
 * the same project), writes the audit row fail-closed, notifies approvers
 * fail-soft, and returns 202 with the request.
 */
export const DELETE = route(async ({ actor, params, request }) => {
  requireScope(actor, "project:delete:request");

  const db = createAdminClient();

  // Fetch the project (must belong to this workspace)
  const { data: project, error: fetchError } = await db
    .from("projects")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!project) throw new NotFoundError("Project not found");

  // A locked project (baseline frozen) can't be deleted: refuse at REQUEST time
  // — same pre-check, same 422 and same blocked-attempt audit row as the task
  // path — instead of letting a doomed request sit in the approvers' queue until
  // the commit RPC trips PROJECT_LOCKED. That commit-time check (migration 0032)
  // stays as the backstop for a lock applied after the request was raised.
  await assertProjectUnlocked(db, params.id, actor.workspaceId, () =>
    writeAudit({
      workspaceId: actor.workspaceId,
      actor,
      action: "project.delete_request.blocked",
      targetType: "project",
      targetId: params.id,
      before: null,
      after: { reason: "project_locked", project_id: params.id },
    }),
  );

  // Check for an existing pending deletion request for this project
  // (uniq_pending_deletion also enforces this at the DB level — this check
  // just returns a clean 422 instead of a raw insert conflict).
  const { data: existingRequest } = await db
    .from("deletion_requests")
    .select("id")
    .eq("workspace_id", actor.workspaceId)
    .eq("target_type", "project")
    .eq("target_id", params.id)
    .eq("status", "pending")
    .maybeSingle();

  if (existingRequest) {
    throw new RuleError(
      "A pending deletion request already exists for this project",
      "duplicate_deletion_request",
    );
  }

  const body = await safeJson(request);
  const parsed = ProjectDeleteRequestSchema.safeParse(body ?? {});
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
      target_type: "project",
      target_id: params.id,
      reason,
      status: "pending",
      requested_by_type: actor.type,
      requested_by_id: actor.id,
      requested_by_label: actor.label,
      // The HUMAN behind the requester (the user, or the token's creator) —
      // four-eyes compares this, not the actor id.
      requested_principal_id: principalOf(actor),
      before: project,
    })
    .select()
    .single();

  if (insertError || !deletionRequest) {
    throw new Error(insertError?.message ?? "Failed to create deletion request");
  }

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "project.delete_requested",
    targetType: "project",
    targetId: params.id,
    before: project,
    after: null,
  });

  // Notify approvers — fail-soft (never throws)
  void resolveWorkspaceApprovers(actor.workspaceId).then((approverIds) => {
    return notify({
      workspaceId: actor.workspaceId,
      recipientIds: approverIds,
      type: "approval.requested",
      title: `Deletion request: project "${project.name ?? params.id}"`,
      body: reason ?? undefined,
      payload: { href: "/approvals", projectId: params.id, requestId: deletionRequest.id },
    });
  });

  // Tell the integration hub (chat approval cards) — never throws, runs after
  // the request and its audit row are committed.
  announceRequested({
    workspaceId: actor.workspaceId,
    kind: "project_deletion",
    id: deletionRequest.id,
    title: `Delete project "${project.name ?? params.id}"`,
    summary: reason ?? null,
    projectId: params.id,
    projectName: project.name ?? null,
    requestedByLabel: actorLabel(actor),
    requesterPrincipalId: principalOf(actor),
  });

  // Return 202 Accepted with the deletion_request
  return NextResponse.json({ data: deletionRequest }, { status: 202 });
});

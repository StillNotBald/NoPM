import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, noContent, validationError, safeJson } from "@/lib/api/response";
import { NotFoundError, PreconditionFailedError } from "@/lib/api/errors";
import { checkOptimisticConcurrency } from "@/lib/api/occ";
import { writeAudit } from "@/lib/audit/write";
import { updateMilestoneSchema } from "@/app/api/milestones/_schema";
import {
  assertProjectUnlocked,
  changedScheduleShapeFields,
  SCHEDULE_SHAPE_MILESTONE_FIELDS,
} from "@/lib/governance/lock";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";

export const runtime = "nodejs";

// GET /api/milestones/[id]
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "milestone:read");

  const db = createAdminClient();

  const { data: milestone, error } = await db
    .from("milestones")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!milestone) throw new NotFoundError("Milestone not found");

  return ok(milestone);
});

// PATCH /api/milestones/[id]
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "milestone:write");

  const db = createAdminClient();

  // Fetch existing for workspace check + before snapshot
  const { data: existing, error: fetchError } = await db
    .from("milestones")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Milestone not found");

  // Parse and validate body
  const body = await safeJson(request);
  const parsed = updateMilestoneSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const fields = parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    }));
    return validationError("Invalid milestone data", fields);
  }

  const input = parsed.data;

  // Cross-tenant guard: owner_id is a profile and must belong to THIS workspace.
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "profiles", id: input.owner_id, field: "owner_id" },
  ]);

  // Optimistic concurrency (R-90) — opt-in via expected_updated_at. No-op when
  // the caller doesn't send it (today's last-write-wins, unchanged).
  checkOptimisticConcurrency(existing.updated_at, input.expected_updated_at);

  // Schedule-shape CHANGES (target/baseline dates) are blocked while the
  // parent project is locked; status/completion/owner/etc stay live. Only a real
  // value change counts — the DB trigger (0028) and the project route compare
  // values too, so a form that echoes the whole record back is not blocked.
  const frozenFields = changedScheduleShapeFields(input, existing, SCHEDULE_SHAPE_MILESTONE_FIELDS);
  if (frozenFields.length > 0) {
    await assertProjectUnlocked(db, existing.project_id, actor.workspaceId, () =>
      writeAudit({
        workspaceId: actor.workspaceId,
        actor,
        action: "milestone.update.blocked",
        targetType: "milestone",
        targetId: params.id,
        before: null,
        after: { reason: "project_locked", project_id: existing.project_id, fields: frozenFields },
      }),
    );
  }

  // Build update payload — only include fields that were explicitly provided
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.target_date !== undefined) updates.target_date = input.target_date;
  if (input.status !== undefined) updates.status = input.status;
  if (input.completion_pct !== undefined) updates.completion_pct = input.completion_pct;
  if (input.owner_id !== undefined) updates.owner_id = input.owner_id;
  if (input.sort_order !== undefined) updates.sort_order = input.sort_order;

  let query = db
    .from("milestones")
    .update(updates)
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);
  // Defense-in-depth: also scope the write itself to the row's pre-check
  // updated_at, closing the (narrow) race between the fetch above and this
  // write. On a lost race the row exists but the filter matches zero rows —
  // maybeSingle() returns null instead of PostgREST's "no rows" error.
  if (input.expected_updated_at !== undefined) {
    query = query.eq("updated_at", existing.updated_at);
  }
  const { data: updated, error: updateError } = await query.select().maybeSingle();

  if (updateError) throw new Error(updateError.message);
  if (!updated) {
    if (input.expected_updated_at !== undefined) {
      throw new PreconditionFailedError("Record changed since you loaded it");
    }
    throw new NotFoundError("Milestone not found");
  }

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "milestone.update",
    targetType: "milestone",
    targetId: params.id,
    before: existing,
    after: updated,
  });

  return ok(updated);
});

// DELETE /api/milestones/[id]
export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "milestone:write");

  const db = createAdminClient();

  // Fetch existing for workspace check + before snapshot
  const { data: existing, error: fetchError } = await db
    .from("milestones")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Milestone not found");

  // Deleting a milestone removes it from the schedule — always blocked while
  // the parent project's baseline is frozen.
  await assertProjectUnlocked(db, existing.project_id, actor.workspaceId, () =>
    writeAudit({
      workspaceId: actor.workspaceId,
      actor,
      action: "milestone.delete.blocked",
      targetType: "milestone",
      targetId: params.id,
      before: null,
      after: { reason: "project_locked", project_id: existing.project_id },
    }),
  );

  const { error: deleteError } = await db
    .from("milestones")
    .delete()
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (deleteError) throw new Error(deleteError.message);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "milestone.delete",
    targetType: "milestone",
    targetId: params.id,
    before: existing,
    after: null,
  });

  return noContent();
});

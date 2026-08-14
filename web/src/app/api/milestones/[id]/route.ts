import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, noContent, validationError, safeJson } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit/write";
import { updateMilestoneSchema } from "@/app/api/milestones/_schema";
import {
  assertProjectUnlocked,
  SCHEDULE_SHAPE_MILESTONE_FIELDS,
  touchesScheduleShape,
} from "@/lib/governance/lock";

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

  // Schedule-shape changes (target/baseline dates) are blocked while the
  // parent project is locked; status/completion/owner/etc stay live.
  if (touchesScheduleShape(input, SCHEDULE_SHAPE_MILESTONE_FIELDS)) {
    await assertProjectUnlocked(db, existing.project_id, actor.workspaceId, () =>
      writeAudit({
        workspaceId: actor.workspaceId,
        actor,
        action: "milestone.update.blocked",
        targetType: "milestone",
        targetId: params.id,
        before: null,
        after: { reason: "project_locked", project_id: existing.project_id },
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

  const { data: updated, error: updateError } = await db
    .from("milestones")
    .update(updates)
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError) throw new Error(updateError.message);

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

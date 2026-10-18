import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { noContent, ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { updateSprintSchema } from "../_schema";
import { unknownFieldsResponse } from "@/lib/work/unknown-fields";
import { withTimingFlag } from "@/lib/sprints/flags";

export const runtime = "nodejs";

// GET /api/sprints/[id] — fetch a single sprint (sprint:read)
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "sprint:read");

  const db = createAdminClient();
  const { data, error } = await db
    .from("sprints")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new NotFoundError("Sprint not found");

  return ok(withTimingFlag(data));
});

/**
 * PATCH /api/sprints/[id] — partial update of name/goal/dates ONLY
 * (sprint:write). `state` is never settable here — see POST /start and
 * POST /close. A closed sprint rejects every PATCH (dates immutable once
 * closed, per the owner-locked decision — and since closed is terminal,
 * name/goal are frozen alongside the dates rather than carving out a
 * partial exception).
 */
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "sprint:write");

  const db = createAdminClient();

  const { data: before, error: fetchError } = await db
    .from("sprints")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!before) throw new NotFoundError("Sprint not found");

  if (before.state === "closed") {
    throw new RuleError("Closed sprints cannot be edited");
  }

  const body = await safeJson(request);
  const unknown = unknownFieldsResponse(body, updateSprintSchema);
  if (unknown) return unknown;
  const parsed = updateSprintSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid sprint data",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const nextStart = parsed.data.start_date ?? before.start_date;
  const nextEnd = parsed.data.end_date ?? before.end_date;
  if (nextEnd < nextStart) {
    return validationError("Invalid sprint dates", [
      { field: "end_date", message: "end_date must be on or after start_date" },
    ]);
  }

  const now = new Date().toISOString();
  const { data: after, error: updateError } = await db
    .from("sprints")
    .update({
      ...parsed.data,
      workspace_id: actor.workspaceId, // never let caller overwrite
      updated_at: now,
    })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError) throw updateError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "sprint.update",
    targetType: "sprint",
    targetId: params.id,
    before,
    after,
  });

  return ok(after);
});

/**
 * DELETE /api/sprints/[id] — plain single-step hard delete, ONLY while the
 * sprint is still `planned` and has no attached tasks (sprint:write).
 * NOT routed through deletion_requests — mirrors programs/milestones/risks.
 */
export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "sprint:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("sprints")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!existing) throw new NotFoundError("Sprint not found");

  if (existing.state !== "planned") {
    throw new RuleError("Only a planned sprint can be deleted");
  }

  const { count: attachedCount, error: countError } = await db
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", actor.workspaceId)
    .eq("sprint_id", params.id);

  if (countError) throw countError;
  if ((attachedCount ?? 0) > 0) {
    throw new RuleError("Sprint has attached tasks — detach them before deleting");
  }

  const { error: deleteError } = await db
    .from("sprints")
    .delete()
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (deleteError) throw deleteError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "sprint.delete",
    targetType: "sprint",
    targetId: existing.id,
    before: existing,
    after: null,
  });

  return noContent();
});

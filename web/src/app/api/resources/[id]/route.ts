import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { ok, noContent, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit/write";
import { createAdminClient } from "@/lib/supabase/admin";
import { patchResourceSchema } from "../_schema";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";
import { weekLockRuleError } from "@/lib/governance/period-lock";

export const runtime = "nodejs";

export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "resource:read");

  const db = createAdminClient();
  const { data, error } = await db
    .from("resource_members")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new NotFoundError("Resource member not found");

  return ok(data);
});

export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "resource:write");

  const db = createAdminClient();
  const { data: existing, error: fetchError } = await db
    .from("resource_members")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!existing) throw new NotFoundError("Resource member not found");

  const body = await safeJson(request);
  const parsed = patchResourceSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid resource payload",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  // Cross-tenant guard: the linked login (profile) must belong to THIS workspace.
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "profiles", id: parsed.data.profile_id, field: "profile_id" },
  ]);

  const { data: updated, error: updateError } = await db
    .from("resource_members")
    .update({ ...parsed.data })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError) throw updateError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "resource.update",
    targetType: "resource_member",
    targetId: params.id,
    before: existing,
    after: updated,
  });

  return ok(updated);
});

export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "resource:write");

  const db = createAdminClient();
  const { data: existing, error: fetchError } = await db
    .from("resource_members")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!existing) throw new NotFoundError("Resource member not found");

  // time_entries and timesheet_submissions both cascade from the member, so a
  // delete would erase the member's hours AND the submit/approve/reject record
  // of every sheet in one "resource.delete" audit row. A member who has ever had
  // a sheet is part of the approval history: refuse rather than erase it.
  const { data: sheets, error: sheetsError } = await db
    .from("timesheet_submissions")
    .select("id")
    .eq("member_id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .limit(1);

  if (sheetsError) throw sheetsError;
  if (sheets && sheets.length > 0) {
    throw new RuleError(
      "This member has timesheet records (submitted, approved or rejected weeks) and cannot be deleted — their approval history would be erased with them.",
      "has_timesheet_records",
    );
  }

  const { error: deleteError } = await db
    .from("resource_members")
    .delete()
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);

  // The cascade to time_entries trips the week-lock triggers (P0011 / P0012) if
  // a sheet appeared since the check above: a clean 422, not a 500.
  if (deleteError) throw weekLockRuleError(deleteError) ?? deleteError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "resource.delete",
    targetType: "resource_member",
    targetId: params.id,
    before: existing,
    after: null,
  });

  return noContent();
});

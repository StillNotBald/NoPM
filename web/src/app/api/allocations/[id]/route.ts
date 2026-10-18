import { z } from "zod";
import { NextResponse } from "next/server";
import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { ok, noContent, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit/write";
import { createAdminClient } from "@/lib/supabase/admin";
import { detectOverAllocationSafe } from "@/lib/clash/detect";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";
import { unknownFieldsResponse } from "@/lib/work/unknown-fields";

export const runtime = "nodejs";

const patchAllocationSchema = z.object({
  member_id: z.string().uuid().optional(),
  project_id: z.string().uuid().optional().nullable(),
  task_id: z.string().uuid().optional().nullable(),
  // Not nullable and capped at 500 to match the NOT NULL column + its check constraint (null/999 used to be a DB 500).
  allocation_pct: z.number().min(0).max(500).optional(),
  hours: z.number().nonnegative().optional().nullable(),
  window_start: z.string().datetime().optional().nullable(),
  window_end: z.string().datetime().optional().nullable(),
});

export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "resource:read");

  const db = createAdminClient();
  const { data, error } = await db
    .from("allocations")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new NotFoundError("Allocation not found");

  return ok(data);
});

export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "resource:write");

  const db = createAdminClient();
  const { data: existing, error: fetchError } = await db
    .from("allocations")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!existing) throw new NotFoundError("Allocation not found");

  const body = await safeJson(request);
  const unknown = unknownFieldsResponse(body, patchAllocationSchema);
  if (unknown) return unknown;
  const parsed = patchAllocationSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid allocation payload",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  // Cross-tenant guard (see POST /api/allocations).
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "resource_members", id: parsed.data.member_id, field: "member_id" },
    { table: "projects", id: parsed.data.project_id, field: "project_id" },
    { table: "tasks", id: parsed.data.task_id, field: "task_id" },
  ]);

  const { data: updated, error: updateError } = await db
    .from("allocations")
    .update({ ...parsed.data })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError) throw updateError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "allocation.update",
    targetType: "allocation",
    targetId: params.id,
    before: existing,
    after: updated,
  });

  // Re-run detection for both old and new member_id if it changed
  const memberId: string = parsed.data.member_id ?? existing.member_id;
  // Fail-soft: the update is already saved and audited, so a detector failure
  // is reported as a warning rather than a 500.
  const warnings: string[] = [];
  const first = await detectOverAllocationSafe(db, actor.workspaceId, memberId, actor);
  if (first.warning) warnings.push(first.warning);
  if (parsed.data.member_id && parsed.data.member_id !== existing.member_id) {
    const second = await detectOverAllocationSafe(db, actor.workspaceId, existing.member_id, actor);
    if (second.warning && !warnings.includes(second.warning)) warnings.push(second.warning);
  }

  return warnings.length ? NextResponse.json({ data: updated, warnings }) : ok(updated);
});

export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "resource:write");

  const db = createAdminClient();
  const { data: existing, error: fetchError } = await db
    .from("allocations")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!existing) throw new NotFoundError("Allocation not found");

  const { error: deleteError } = await db
    .from("allocations")
    .delete()
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (deleteError) throw deleteError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "allocation.delete",
    targetType: "allocation",
    targetId: params.id,
    before: existing,
    after: null,
  });

  // Re-check the member's allocation state after deletion
  await detectOverAllocationSafe(db, actor.workspaceId, existing.member_id, actor);

  return noContent();
});

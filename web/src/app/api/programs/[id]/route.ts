import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { noContent, ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { unknownFieldsResponse } from "@/lib/work/unknown-fields";
import { updateProgramSchema } from "../_schema";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";

export const runtime = "nodejs";

// GET /api/programs/[id] — fetch a single program (program:read)
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "program:read");

  const db = createAdminClient();
  const { data, error } = await db
    .from("programs")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new NotFoundError("Program not found");

  return ok(data);
});

// PATCH /api/programs/[id] — partial update (program:write)
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "program:write");

  const db = createAdminClient();

  const { data: before, error: fetchError } = await db
    .from("programs")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!before) throw new NotFoundError("Program not found");

  const body = await safeJson(request);
  const unknown = unknownFieldsResponse(body, updateProgramSchema);
  if (unknown) return unknown;
  const parsed = updateProgramSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid program data",
      parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    );
  }

  // Cross-tenant guard: owner_id is a resource_member of THIS workspace.
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "resource_members", id: parsed.data.owner_id, field: "owner_id" },
  ]);

  const now = new Date().toISOString();
  const { data: after, error: updateError } = await db
    .from("programs")
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
    action: "program.update",
    targetType: "program",
    targetId: params.id,
    before,
    after,
  });

  return ok(after);
});

/**
 * DELETE /api/programs/[id] — a PLAIN single-step hard delete with exactly
 * one audit row. NOT routed through deletion_requests.
 *
 * Owner-locked (Decision 3, requirements/devops-wave1/README.md): the
 * four-eyes maker-checker deletion flow extends to PROJECTS ONLY. Programs
 * behave like milestones/risks/issues here — audit-only hard delete, no
 * maker-checker step, mirroring src/app/api/risks/[id]/route.ts's DELETE
 * exactly.
 *
 * Deleting a program NEVER deletes or cascades into its child projects:
 * projects.program_id is FK'd `on delete set null` (migration
 * 20260815000034), so children simply lose their program grouping and keep
 * every other field — including their legacy `program` text label — intact.
 */
export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "program:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("programs")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!existing) throw new NotFoundError("Program not found");

  const { error: deleteError } = await db
    .from("programs")
    .delete()
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (deleteError) throw deleteError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "program.delete",
    targetType: "program",
    targetId: existing.id,
    before: existing,
    after: null,
  });

  return noContent();
});

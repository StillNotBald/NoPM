import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditedUpdate } from "@/lib/audit/audited-write";
import { requestDeletion } from "@/lib/governance/request-deletion";
import { ok, safeJson, validationError } from "@/lib/api/response";
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
  // Row and audit row are one transaction (nopm_mutate_audited).
  const { after } = await auditedUpdate({
    table: "programs",
    actor,
    action: "program.update",
    id: params.id,
    patch: { ...parsed.data, updated_at: now },
    notFoundMessage: "Program not found",
  });

  return ok(after);
});

/**
 * DELETE /api/programs/[id] — does NOT delete the program. It raises a deletion request (scope program:write, as the
 * direct delete had) with a required `reason` and returns 202 with the deletion_requests row. A second person approves
 * it at POST /api/deletion-requests/:id/approve (R-176; the database refuses any other DELETE after migration 0114).
 * A program deletion is HIGH RISK: only an admin approves it. Approving never deletes the program's projects: they
 * lose the grouping (projects.program_id is on delete set null) and keep every other field.
 */
export const DELETE = route(async ({ actor, params, request }) =>
  requestDeletion({ actor, request, entity: "program", id: params.id }),
);

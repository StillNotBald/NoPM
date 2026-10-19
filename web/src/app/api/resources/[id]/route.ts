import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { auditedUpdate } from "@/lib/audit/audited-write";
import { requestDeletion } from "@/lib/governance/request-deletion";
import { createAdminClient } from "@/lib/supabase/admin";
import { createResourceSchema, patchResourceSchema } from "../_schema";
import { unknownFieldsResponse } from "@/lib/work/unknown-fields";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";

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
  const unknown = unknownFieldsResponse(body, createResourceSchema);
  if (unknown) return unknown;
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

  // Row and audit row are one transaction (nopm_mutate_audited).
  const { after: updated } = await auditedUpdate({
    table: "resource_members",
    actor,
    action: "resource.update",
    id: params.id,
    patch: { ...parsed.data },
    notFoundMessage: "Resource member not found",
  });

  return ok(updated);
});

/**
 * DELETE /api/resources/[id] — does NOT delete the member. It raises a deletion request (scope resource:write, as the
 * direct delete had) with a required `reason` and returns 202 with the deletion_requests row. A member who has archived
 * timesheets is refused (422 has_timesheet_records), now and again at approval. The request records the member's
 * allocations; approving deletes them with the member and lists their ids on the audit trail (R-176).
 */
export const DELETE = route(async ({ actor, params, request }) =>
  requestDeletion({ actor, request, entity: "resource", id: params.id }),
);

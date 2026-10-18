import { NextResponse } from "next/server";
import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { NotFoundError } from "@/lib/api/errors";
import { auditedDelete } from "@/lib/audit/audited-write";
import { loadWorkspaceProject } from "../_shared";

export const runtime = "nodejs";

/**
 * DELETE /api/projects/:id/dependencies/:depId - remove a declared dependency.
 * Allowed on a locked project for the same reason as adding one (see the POST
 * route): a project dependency is not part of the locked schedule baseline.
 */
export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "project:write");
  const db = createAdminClient();
  await loadWorkspaceProject(db, actor.workspaceId, params.id);

  const { data: dep, error: findErr } = await db
    .from("project_dependencies")
    .select("*")
    .eq("id", params.depId)
    .eq("workspace_id", actor.workspaceId)
    .eq("project_id", params.id)
    .maybeSingle();
  if (findErr) throw new Error(findErr.message);
  if (!dep) throw new NotFoundError("Dependency not found");

  // Row and audit row are one transaction (nopm_mutate_audited, migration 0103); the audit
  // row targets the project, as before.
  await auditedDelete({
    table: "project_dependencies",
    actor,
    action: "project.dependency.remove",
    targetType: "project",
    auditTargetId: params.id,
    id: params.depId,
    notFoundMessage: "Dependency not found",
  });

  return new NextResponse(null, { status: 204 });
});

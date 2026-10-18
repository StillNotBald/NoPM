import { NextResponse } from "next/server";
import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { NotFoundError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit/write";
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

  const { error: delErr } = await db
    .from("project_dependencies")
    .delete()
    .eq("id", params.depId)
    .eq("workspace_id", actor.workspaceId)
    .eq("project_id", params.id);
  if (delErr) throw new Error(delErr.message);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "project.dependency.remove",
    targetType: "project",
    targetId: params.id,
    before: dep,
    after: null,
  });

  return new NextResponse(null, { status: 204 });
});

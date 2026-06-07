import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";

export const runtime = "nodejs";

// POST /api/projects/[id]/unlock — unlock project timeline (project:write)
export const POST = route(async ({ actor, params }) => {
  requireScope(actor, "project:write");

  const db = createAdminClient();

  const { data: before, error: fetchError } = await db
    .from("projects")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!before) throw new NotFoundError("Project not found");

  const { data: after, error: updateError } = await db
    .from("projects")
    .update({
      is_locked: false,
      locked_by: null,
      locked_at: null,
      lock_reason: null,
    })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError) throw updateError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "project.unlock",
    targetType: "project",
    targetId: params.id,
    before,
    after,
  });

  return ok(after);
});

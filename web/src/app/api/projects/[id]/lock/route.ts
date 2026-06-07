import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { lockProjectSchema } from "@/app/api/rebaselines/_schema";

export const runtime = "nodejs";

// POST /api/projects/[id]/lock — lock project timeline (project:write)
export const POST = route(async ({ actor, params, request }) => {
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

  const body = await safeJson(request);
  const parsed = lockProjectSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    );
  }

  const now = new Date().toISOString();

  const { data: after, error: updateError } = await db
    .from("projects")
    .update({
      is_locked: true,
      locked_by: actor.type === "user" ? actor.id : null,
      locked_at: now,
      lock_reason: parsed.data.reason ?? null,
    })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError) throw updateError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "project.lock",
    targetType: "project",
    targetId: params.id,
    before,
    after,
  });

  return ok(after);
});

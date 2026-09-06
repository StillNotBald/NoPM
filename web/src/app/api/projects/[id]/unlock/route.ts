import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { unlockProjectSchema } from "@/app/api/rebaselines/_schema";

export const runtime = "nodejs";

// POST /api/projects/[id]/unlock — unlock project timeline (project:write)
// Body: { reason: string } REQUIRED (R-83 — governed unlock: unlike lock's
// optional reason, unlocking a frozen baseline must always say why).
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
  const parsed = unlockProjectSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    );
  }

  const { reason } = parsed.data;

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

  // lock_reason is nulled on the row itself (nothing new is stored there) —
  // the WHY the unlock happened lives only in the audit trail's `after`.
  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "project.unlock",
    targetType: "project",
    targetId: params.id,
    before,
    after: { ...after, unlock_reason: reason },
  });

  return ok(after);
});

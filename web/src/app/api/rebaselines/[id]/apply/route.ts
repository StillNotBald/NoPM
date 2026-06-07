import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";

export const runtime = "nodejs";

// POST /api/rebaselines/[id]/apply — apply an approved rebaseline (project:write)
export const POST = route(async ({ actor, params }) => {
  requireScope(actor, "project:write");

  const db = createAdminClient();

  // Load rebaseline — must belong to actor's workspace
  const { data: rebaseline, error: fetchError } = await db
    .from("rebaselines")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!rebaseline) throw new NotFoundError("Rebaseline not found");

  // Only approved rebaselines may be applied
  if (rebaseline.status !== "approved") {
    throw new RuleError(
      `Rebaseline cannot be applied: status is '${rebaseline.status}', must be 'approved'`,
    );
  }

  const now = new Date().toISOString();

  const { data: after, error: updateError } = await db
    .from("rebaselines")
    .update({
      status: "applied",
      applied_at: now,
    })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError) throw updateError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "rebaseline.apply",
    targetType: "rebaseline",
    targetId: params.id,
    before: rebaseline,
    after,
  });

  return ok(after);
});

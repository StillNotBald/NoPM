import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { signoffSchema } from "@/app/api/rebaselines/_schema";

export const runtime = "nodejs";

// POST /api/rebaselines/[id]/signoff — cast or update a signoff vote (project:write)
export const POST = route(async ({ actor, params, request }) => {
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

  const body = await safeJson(request);
  const parsed = signoffSchema.safeParse(body);
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
  const approverId = actor.id;

  // Upsert the signoff row for (rebaseline_id, approver_id)
  const { data: signoff, error: upsertError } = await db
    .from("rebaseline_signoffs")
    .upsert(
      {
        workspace_id: actor.workspaceId,
        rebaseline_id: params.id,
        approver_id: approverId,
        vote: parsed.data.vote,
        voted_at: now,
        comment: parsed.data.comment ?? null,
      },
      {
        onConflict: "rebaseline_id,approver_id",
      },
    )
    .select()
    .single();

  if (upsertError) throw upsertError;

  // Recompute rebaseline status from all signoffs
  const { data: allSignoffs, error: signoffsError } = await db
    .from("rebaseline_signoffs")
    .select("vote")
    .eq("rebaseline_id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (signoffsError) throw signoffsError;

  const votes = allSignoffs ?? [];
  const hasNoGo = votes.some((s) => s.vote === "no_go");
  const hasGo = votes.some((s) => s.vote === "go");
  const hasPending = votes.some((s) => s.vote === "pending");

  let newStatus: string = rebaseline.status;
  if (hasNoGo) {
    newStatus = "rejected";
  } else if (hasGo && !hasPending) {
    newStatus = "approved";
  }

  const beforeRebaseline = { ...rebaseline };

  const { data: updatedRebaseline, error: updateError } = await db
    .from("rebaselines")
    .update({ status: newStatus })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError) throw updateError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "rebaseline.signoff",
    targetType: "rebaseline",
    targetId: params.id,
    before: beforeRebaseline,
    after: updatedRebaseline,
  });

  return ok({ signoff, rebaseline: updatedRebaseline });
});

import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { unlockProjectSchema } from "@/app/api/rebaselines/_schema";

export const runtime = "nodejs";

/** What nopm_unlock_project reports for each rebaseline it voided. */
type CancelledRebaseline = { id: string; version: number; previous_status: string };

// POST /api/projects/[id]/unlock — unlock project timeline (project:write)
// Body: { reason: string } REQUIRED (R-83 — governed unlock: unlike lock's
// optional reason, unlocking a frozen baseline must always say why).
// Side effect (owner decision 2026-10-17): the project's pending_approval and
// approved rebaselines are cancelled in the same transaction.
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

  // Unlock AND void the project's open rebaselines in ONE transaction
  // (nopm_unlock_project, migration 0058). Owner decision 2026-10-17: a pending
  // or approved rebaseline must never survive an unlock, because the apply step
  // copies the LIVE dates — someone could otherwise unlock, edit the dates,
  // relock, and have an already-approved rebaseline applied on dates its
  // approvers never saw. Doing it in one function means it is fail-closed: if
  // the cancellation cannot happen, the unlock does not stand (and a database
  // without 0058 fails the call rather than unlocking without cancelling).
  // Drafts are left alone: they were proposed on an unlocked project, carry no
  // sign-off, and can neither be signed off nor applied.
  const { data: result, error: unlockError } = await db.rpc("nopm_unlock_project", {
    p_project_id: params.id,
    p_workspace_id: actor.workspaceId,
  });

  if (unlockError) throw unlockError;

  const { project: after, cancelled } = result as {
    project: Record<string, unknown>;
    cancelled: CancelledRebaseline[] | null;
  };
  const cancelledRebaselines = cancelled ?? [];

  // lock_reason is nulled on the row itself (nothing new is stored there) —
  // the WHY the unlock happened lives only in the audit trail's `after`.
  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "project.unlock",
    targetType: "project",
    targetId: params.id,
    before,
    after: { ...after, unlock_reason: reason, cancelled_rebaselines: cancelledRebaselines.map((r) => r.id) },
  });

  // One audit row per voided rebaseline, so each one's own history shows why it
  // ended (the rebaseline's History / Trust Center stream is keyed by target).
  for (const r of cancelledRebaselines) {
    await writeAudit({
      workspaceId: actor.workspaceId,
      actor,
      action: "rebaseline.cancelled",
      targetType: "rebaseline",
      targetId: r.id,
      before: { id: r.id, project_id: params.id, version: r.version, status: r.previous_status },
      after: {
        id: r.id,
        project_id: params.id,
        version: r.version,
        status: "cancelled",
        reason: "project_unlocked",
        unlock_reason: reason,
      },
    });
  }

  return ok(after);
});

import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { assertNotRequesterPrincipal, requirePrincipal } from "@/lib/governance/decide";
import { assertSignoffOpen, statusFromVotes } from "@/lib/governance/rebaseline-lifecycle";
import { signoffSchema } from "@/app/api/rebaselines/_schema";

export const runtime = "nodejs";

// POST /api/rebaselines/[id]/signoff — cast or update a signoff vote (rebaseline:approve)
//
// Principal-aware four-eyes (0045): the vote is cast by a HUMAN. A session user
// votes as themselves; a token votes as the person who minted it (so a person
// has exactly one vote per rebaseline however many identities they hold, and
// rebaseline_signoffs.approver_id — an FK to profiles — is always a real
// profile). A token with no recorded owner can't vote: 403, not the FK 500 it
// used to be.
//
// Votes are accepted only while the rebaseline is `pending_approval` (R1/M2):
// a rejected rebaseline cannot be revived by flipping a vote, an applied one
// cannot regress to approved, a draft is not awaiting sign-off. The status write
// is a compare-and-set on that state, and the rebaselines trigger of migration
// 0049 is the backstop.
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "rebaseline:approve");
  const principal = requirePrincipal(actor);

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

  // Four-eyes: the requester may not sign off their own rebaseline (R-04).
  // The legacy user-id check keeps its 422; the principal check also catches a
  // token the requester minted (or a token raised by, and signed by, the same
  // person). A DB trigger (0022, principal-aware since 0045) is the backstop.
  if (actor.type === "user" && rebaseline.requested_by && actor.id === rebaseline.requested_by) {
    throw new RuleError("Four-eyes: you cannot sign off a rebaseline you requested.", "self_approval");
  }
  assertNotRequesterPrincipal(
    rebaseline.requested_principal_id,
    principal,
    "Four-eyes: you cannot sign off a rebaseline you requested.",
  );

  assertSignoffOpen(rebaseline.status);

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
  const approverId = principal;

  // Upsert the signoff row for (rebaseline_id, approver_id)
  const { data: signoff, error: upsertError } = await db
    .from("rebaseline_signoffs")
    .upsert(
      {
        workspace_id: actor.workspaceId,
        rebaseline_id: params.id,
        approver_id: approverId,
        approver_principal_id: principal,
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

  const newStatus = statusFromVotes(allSignoffs ?? [], rebaseline.status);

  const beforeRebaseline = { ...rebaseline };

  // Compare-and-set on the state the vote was accepted in: if a concurrent
  // sign-off already decided the rebaseline, this write matches nothing.
  const { data: updatedRebaseline, error: updateError } = await db
    .from("rebaselines")
    .update({ status: newStatus })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .eq("status", "pending_approval")
    .select()
    .maybeSingle();

  if (updateError) throw updateError;
  if (!updatedRebaseline) {
    throw new RuleError("This rebaseline was decided while your vote was being recorded.", "rebaseline_not_pending");
  }

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

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

  // The voter's previous vote on this rebaseline, if any: it is what a changed
  // vote replaces, so the audit row keeps it and a rollback can restore it.
  const { data: previousVote, error: previousError } = await db
    .from("rebaseline_signoffs")
    .select("vote, comment, voted_at")
    .eq("rebaseline_id", params.id)
    .eq("approver_id", approverId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (previousError) throw previousError;

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

  // From here the vote is only provisional: it stands if, and only if, the
  // status write below lands. Anything else (a concurrent sign-off decided the
  // rebaseline first, a DB error) takes the vote back out, so a vote can never
  // persist next to a status it contradicts (B votes go and approves while A's
  // concurrent no_go is recorded but its own status write loses: A's row must
  // not survive beside `approved`).
  const withdrawVote = async () => {
    const { error } = previousVote
      ? await db
          .from("rebaseline_signoffs")
          .upsert(
            {
              workspace_id: actor.workspaceId,
              rebaseline_id: params.id,
              approver_id: approverId,
              approver_principal_id: principal,
              vote: previousVote.vote,
              voted_at: previousVote.voted_at ?? null,
              comment: previousVote.comment ?? null,
            },
            { onConflict: "rebaseline_id,approver_id" },
          )
      : await db
          .from("rebaseline_signoffs")
          .delete()
          .eq("rebaseline_id", params.id)
          .eq("approver_id", approverId)
          .eq("workspace_id", actor.workspaceId);
    // A vote that cannot be withdrawn is worse than a failed request: surface it.
    if (error) throw error;
  };

  let updatedRebaseline: Record<string, unknown> | null = null;
  try {
    // Recompute rebaseline status from all signoffs
    const { data: allSignoffs, error: signoffsError } = await db
      .from("rebaseline_signoffs")
      .select("vote")
      .eq("rebaseline_id", params.id)
      .eq("workspace_id", actor.workspaceId);

    if (signoffsError) throw signoffsError;

    const newStatus = statusFromVotes(allSignoffs ?? [], rebaseline.status);

    // Compare-and-set on the state the vote was accepted in: if a concurrent
    // sign-off already decided the rebaseline, this write matches nothing.
    const { data, error: updateError } = await db
      .from("rebaselines")
      .update({ status: newStatus })
      .eq("id", params.id)
      .eq("workspace_id", actor.workspaceId)
      .eq("status", "pending_approval")
      .select()
      .maybeSingle();

    if (updateError) throw updateError;
    updatedRebaseline = data;
  } catch (e) {
    await withdrawVote();
    throw e;
  }

  if (!updatedRebaseline) {
    await withdrawVote();
    throw new RuleError("This rebaseline was decided while your vote was being recorded.", "rebaseline_not_pending");
  }

  const beforeRebaseline = { ...rebaseline };

  // The row records the vote itself, not just the rebaseline's status: the vote,
  // its comment, and the voter's previous vote (null on a first vote), so a
  // changed vote is not erased from the trail.
  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "rebaseline.signoff",
    targetType: "rebaseline",
    targetId: params.id,
    before: {
      ...beforeRebaseline,
      signoff: previousVote
        ? { approver_id: approverId, vote: previousVote.vote, comment: previousVote.comment ?? null, voted_at: previousVote.voted_at ?? null }
        : null,
    },
    after: {
      ...updatedRebaseline,
      signoff: {
        approver_id: approverId,
        vote: parsed.data.vote,
        comment: parsed.data.comment ?? null,
        voted_at: now,
        previous_vote: previousVote?.vote ?? null,
      },
    },
  });

  return ok({ signoff, rebaseline: updatedRebaseline });
});

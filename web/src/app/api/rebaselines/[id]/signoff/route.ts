import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { requireApprover } from "@/lib/auth/approver";
import { assertTierRole, tierOf } from "@/lib/governance/tiers";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { actorLabel, announceDecided, assertNotRequesterPrincipal, noteFallbackApprover, requirePrincipal } from "@/lib/governance/decide";
import { rebaselineEvent } from "@/lib/integrations/rebaseline-approval";
import { assertSignoffOpen } from "@/lib/governance/rebaseline-lifecycle";
import { auditRpcArgs, throwRebaselineRpcError } from "@/lib/governance/rebaseline-rpc";
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
  requireApprover(actor); // D-16: sign-off is for admins and managers only

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
  const fallback = await assertTierRole(db, actor, tierOf(rebaseline)); // G2: the tier names the role (D7 fallback)

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

  // The vote, the status it implies and the rebaseline.signoff audit row are ONE
  // database transaction (nopm_signoff_rebaseline, migration 0063): the
  // rebaseline row is locked, the status is re-checked under that lock, and the
  // audit row is written before the commit, so a vote can never stand without
  // its trail or next to a status it contradicts (this replaces the earlier
  // provisional-vote-then-withdraw dance). The function repeats the approver
  // role rule in SQL (P0018).
  const { data, error } = await db.rpc("nopm_signoff_rebaseline", {
    p_rebaseline_id: params.id,
    p_workspace_id: actor.workspaceId,
    p_vote: parsed.data.vote,
    p_comment: parsed.data.comment ?? null,
    p_approver_principal_id: principal,
    ...auditRpcArgs(actor),
  });
  if (error) throwRebaselineRpcError(error, "Failed to record the sign-off");

  const result = data as { signoff: Record<string, unknown>; rebaseline: Record<string, unknown> };
  if (fallback) await noteFallbackApprover(actor, "rebaseline", params.id, tierOf(rebaseline));

  // A vote that settles the rebaseline (approved / rejected) retires its open Lark
  // cards. After the commit, never fails the request.
  const settled = String(result.rebaseline?.status ?? "");
  if (settled && settled !== "pending_approval") {
    try {
      const ev = await rebaselineEvent(db, actor.workspaceId, { ...rebaseline, status: settled });
      announceDecided({
        ...ev,
        status: settled,
        decidedByLabel: actorLabel(actor),
        channel: actor.channel ?? (actor.type === "token" ? "api" : "ui"),
      });
    } catch (err) {
      console.error("[rebaselines] could not announce the sign-off", err);
    }
  }

  return ok({ signoff: result.signoff, rebaseline: result.rebaseline });
});

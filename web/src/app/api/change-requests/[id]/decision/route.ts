import { route } from "@/lib/api/handler";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { notify } from "@/lib/notify/publish";
import { decisionActionSchema } from "@/app/api/change-requests/_schema";

export const runtime = "nodejs";

/**
 * POST /api/change-requests/:id/decision
 * Four-eyes: record an approve / reject / defer decision on a change request.
 * Guards:
 *   - Change request must be in status 'raised' or 'under_review' (else RuleError 422)
 *   - Deciding actor MUST differ from the requested_by profile (ScopeError 403)
 * Effect:
 *   1. Update status → approved | rejected | deferred; set decided_by, decided_by_label, decided_at, decision_rationale
 *   2. writeAudit change_request.decide (before/after)
 *   3. notify requester — fail-soft, type 'change.decided'
 */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "change:write");

  const db = createAdminClient();

  const { data: cr, error: fetchError } = await db
    .from("change_requests")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!cr) throw new NotFoundError("Change request not found");

  // Must be in a decidable status
  if (cr.status !== "raised" && cr.status !== "under_review") {
    throw new RuleError(`Change request already decided (status: ${cr.status})`);
  }

  // Four-eyes: deciding actor cannot be the same as the requester
  if (cr.requested_by && actor.id === cr.requested_by) {
    throw new ScopeError("Self-approval is not allowed (four-eyes)");
  }

  const body = await safeJson(request);
  const parsed = decisionActionSchema.safeParse(body);
  if (!parsed.success) {
    return validationError("Validation failed", parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    })));
  }

  const input = parsed.data;

  const statusMap: Record<string, string> = {
    approve: "approved",
    reject: "rejected",
    defer: "deferred",
  };

  const newStatus = statusMap[input.decision];
  const now = new Date().toISOString();

  const { data: updated, error: updateError } = await db
    .from("change_requests")
    .update({
      status: newStatus,
      decided_by: actor.type === "user" ? actor.id : null,
      decided_by_label: actor.label,
      decision_rationale: input.rationale,
      decided_at: now,
    })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError || !updated) throw new Error(updateError?.message ?? "Update failed");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "change_request.decide",
    targetType: "change_request",
    targetId: updated.id,
    before: cr,
    after: updated,
  });

  // Notify the requester of the decision — fail-soft
  if (cr.requested_by) {
    void notify({
      workspaceId: actor.workspaceId,
      recipientIds: [cr.requested_by as string],
      type: "approval.approved",
      title: `Change request ${cr.reference_id ?? cr.id} was ${newStatus}`,
      body: input.rationale,
      payload: { changeRequestId: cr.id, decision: input.decision, status: newStatus },
    });
  }

  return ok(updated);
});

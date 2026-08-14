import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit/write";
import { notify } from "@/lib/notify/publish";
import { z } from "zod";
import { resolveDeletionApproveScope } from "@/lib/governance/deletion-dispatch";

export const runtime = "nodejs";

const RejectSchema = z.object({
  reason: z.string().max(1000).optional(),
});

/**
 * POST /api/deletion-requests/[id]/reject
 * Checker step: reject a pending deletion request.
 * Requires the scope matching the request's target type (task:delete:approve
 * or project:delete:approve) — per-type gate, resolved after loading.
 * Four-eyes applies to BOTH decisions: the maker_checker_different DB CHECK
 * requires a different decider for any non-pending request, so self-rejection
 * is guarded here too (422) instead of surfacing as a DB constraint 500.
 * Effect:
 *   1. Update the deletion_request: status='rejected', approved_by_* from actor, decided_at=now
 *   2. Write audit "deletion_request.rejected"
 */
export const POST = route(async ({ actor, params, request }) => {
  const body = await safeJson(request);
  const parsed = RejectSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const db = createAdminClient();

  // Load the deletion request (workspace-scoped)
  const { data: deletionRequest, error: fetchError } = await db
    .from("deletion_requests")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!deletionRequest) throw new NotFoundError("Deletion request not found");

  // Per-type checker gate (mirrors approve — guard symmetry on every decision verb)
  requireScope(actor, resolveDeletionApproveScope(deletionRequest.target_type));

  // Must still be pending
  if (deletionRequest.status !== "pending") {
    throw new RuleError("Request already decided");
  }

  // Four-eyes: the decider must differ from the requester (mirrors the
  // maker_checker_different DB CHECK so callers get a 422, not a 500)
  if (
    deletionRequest.requested_by_id === actor.id &&
    deletionRequest.requested_by_type === actor.type
  ) {
    throw new RuleError(
      "A different person must decide this request — self-rejection is blocked (four-eyes)",
    );
  }

  const now = new Date().toISOString();

  // Mark as rejected
  const { error: updateError } = await db
    .from("deletion_requests")
    .update({
      status: "rejected",
      approved_by_type: actor.type,
      approved_by_id: actor.id,
      approved_by_label: actor.label,
      decided_at: now,
    })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (updateError) throw new Error(updateError.message);

  // Audit the governance step
  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "deletion_request.rejected",
    targetType: "deletion_request",
    targetId: deletionRequest.id,
    before: { status: "pending" },
    after: {
      status: "rejected",
      ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    },
  });

  // Notify the original requester — fail-soft
  if (deletionRequest.requested_by_id) {
    void notify({
      workspaceId: actor.workspaceId,
      recipientIds: [deletionRequest.requested_by_id],
      type: "approval.rejected",
      title: "Your deletion request was rejected",
      body: parsed.data.reason ?? `The deletion of ${deletionRequest.target_type} was not approved.`,
      payload: { requestId: deletionRequest.id, targetType: deletionRequest.target_type, targetId: deletionRequest.target_id },
    });
  }

  return ok({ rejected: true });
});

import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit/write";
import { z } from "zod";

export const runtime = "nodejs";

const RejectSchema = z.object({
  reason: z.string().max(1000).optional(),
});

/**
 * POST /api/deletion-requests/[id]/reject
 * Checker step: reject a pending deletion request.
 * Requires scope task:delete:approve.
 * Self-rejection is allowed (the checker may reject their own request — only self-approval is blocked).
 * Effect:
 *   1. Update the deletion_request: status='rejected', approved_by_* from actor, decided_at=now
 *   2. Write audit "deletion_request.rejected"
 */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "task:delete:approve");

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

  // Must still be pending
  if (deletionRequest.status !== "pending") {
    throw new RuleError("Request already decided");
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

  return ok({ rejected: true });
});

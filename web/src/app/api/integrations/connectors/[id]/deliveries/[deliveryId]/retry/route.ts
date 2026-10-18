import { route } from "@/lib/api/handler";
import { ApiError, NotFoundError, RuleError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { writeAudit } from "@/lib/audit/write";
import { createAdminClient } from "@/lib/supabase/admin";
import { drainDeliveries } from "@/lib/integrations/deliveries";
import { assertIntegrationAdmin, getConnector } from "@/lib/integrations/store";

export const runtime = "nodejs";

/**
 * POST /api/integrations/connectors/[id]/deliveries/[deliveryId]/retry
 * (Q-ACC-14, admin only): put one dead message back in the queue with a fresh
 * set of attempts and try it now. The state flip is a compare-and-set on
 * `status = 'dead'` (a second click, or a row that went away, is a clear 422),
 * audited once as `integration.delivery.retry` BEFORE anything is sent. A card
 * for a request that was decided meanwhile is superseded by the drain, never
 * sent.
 */
export const POST = route(async ({ actor, params }) => {
  assertIntegrationAdmin(actor);
  const connector = await getConnector(actor.workspaceId, params.id);
  if (!connector) throw new NotFoundError("Connector not found");
  if (connector.status !== "active") {
    throw new RuleError("The connector must be active to retry a message", "connector_not_active");
  }

  const db = createAdminClient();
  const { data: row, error: readError } = await db
    .from("integration_deliveries")
    .select("id, kind, approval_kind, approval_id, status")
    .eq("id", params.deliveryId)
    .eq("workspace_id", actor.workspaceId)
    .eq("connector_id", connector.id)
    .maybeSingle();
  if (readError) throw readError;
  if (!row) throw new NotFoundError("Delivery not found");
  if (row.status !== "dead") {
    throw new RuleError("Only a failed (dead) message can be retried", "delivery_not_dead");
  }

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "integration.delivery.retry",
    targetType: "integration_delivery",
    targetId: row.id as string,
    before: { status: "dead" },
    after: { status: "pending", kind: row.kind, approval_kind: row.approval_kind ?? null },
  });

  const { data: flipped, error } = await db
    .from("integration_deliveries")
    .update({ status: "pending", attempts: 0, next_attempt_at: new Date().toISOString(), locked_until: null })
    .eq("id", row.id as string)
    .eq("workspace_id", actor.workspaceId)
    .eq("status", "dead")
    .select("id");
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new RuleError("A newer copy of this message is already queued", "delivery_already_queued");
    }
    throw new ApiError(500, "Failed to requeue the message");
  }
  if (!flipped || flipped.length === 0) {
    throw new RuleError("Only a failed (dead) message can be retried", "delivery_not_dead");
  }

  const result = await drainDeliveries({ workspaceId: actor.workspaceId, connectorId: connector.id, ids: [row.id as string] });
  const status = result.sent > 0 ? "sent" : result.retried > 0 ? "retry" : result.dead > 0 ? "dead" : result.superseded > 0 ? "superseded" : "queued";
  return ok({ delivery_id: row.id, status });
});

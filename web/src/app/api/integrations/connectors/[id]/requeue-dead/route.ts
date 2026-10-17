import { route } from "@/lib/api/handler";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { writeAudit } from "@/lib/audit/write";
import { requeueDeadApprovals } from "@/lib/integrations/catchup";
import { assertIntegrationAdmin, getConnector } from "@/lib/integrations/store";

export const runtime = "nodejs";

/**
 * POST /api/integrations/connectors/[id]/requeue-dead: "Requeue dead" (admin
 * session only, the same guard as pause/resume). After the retry ladder is
 * spent (about 14.6 hours of failure) an approval card goes `dead` and nothing
 * redrives it. This sends a fresh card for every request that is still
 * pending and has a dead card, with the same dedupe as the resume catch-up
 * (an approver who already holds a live card gets nothing). Audited BEFORE
 * any card is queued (`integration.approvals.requeue_dead`), because it
 * sends request details to a third party.
 */
export const POST = route(async ({ actor, params }) => {
  assertIntegrationAdmin(actor);

  const connector = await getConnector(actor.workspaceId, params.id);
  if (!connector) throw new NotFoundError("Connector not found");
  if (connector.status !== "active") {
    throw new RuleError("The connector must be active to requeue cards", "connector_not_active");
  }

  const result = await requeueDeadApprovals(connector, (plan) =>
    writeAudit({
      workspaceId: actor.workspaceId,
      actor,
      action: "integration.approvals.requeue_dead",
      targetType: "integration_connector",
      targetId: connector.id,
      after: plan,
    }),
  );
  return ok(result);
});

import { route } from "@/lib/api/handler";
import { ApiError, NotFoundError, RuleError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { writeAudit } from "@/lib/audit/write";
import { drainDeliveries, enqueueDigest } from "@/lib/integrations/deliveries";
import { gatherDigestData } from "@/lib/integrations/digest-data";
import { appBaseUrl, assertIntegrationAdmin, getConnector, normalizeConfig } from "@/lib/integrations/store";

export const runtime = "nodejs";

/**
 * POST /api/integrations/connectors/[id]/digest — "send now" (admin only):
 * gather the workspace digest and post it to the connector's configured group
 * chat, once, immediately. Audited BEFORE anything is queued, because it sends
 * workspace data to a third party (`integration.digest.send`, trigger manual).
 * Manual sends never occupy the once-per-ISO-week scheduled slot.
 */
export const POST = route(async ({ actor, params, request }) => {
  assertIntegrationAdmin(actor);

  const connector = await getConnector(actor.workspaceId, params.id);
  if (!connector) throw new NotFoundError("Connector not found");
  if (connector.status !== "active") {
    throw new RuleError("The connector must be active to send a digest", "connector_not_active");
  }
  const { digest } = normalizeConfig(connector.config);
  if (!digest.chatId) {
    throw new RuleError("Set a digest group chat id on the connector first", "digest_chat_missing");
  }

  const data = await gatherDigestData(actor.workspaceId, { appUrl: appBaseUrl(new URL(request.url).origin) });

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "integration.digest.send",
    targetType: "integration_connector",
    targetId: connector.id,
    after: { trigger: "manual", chat_id: digest.chatId },
  });

  const queued = await enqueueDigest(connector, digest.chatId, data, "manual");
  if (!queued) throw new ApiError(500, "Failed to queue the digest");

  const result = await drainDeliveries({
    workspaceId: actor.workspaceId,
    connectorId: connector.id,
    ids: [queued.id],
  });
  const status = result.sent > 0 ? "sent" : result.retried > 0 ? "retry" : result.dead > 0 ? "dead" : "queued";

  return ok({ delivery_id: queued.id, status });
});

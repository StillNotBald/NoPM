import { route } from "@/lib/api/handler";
import { NotFoundError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { createAdminClient } from "@/lib/supabase/admin";
import { sanitizeError } from "@/lib/integrations/secrets";
import { assertIntegrationAdmin, getConnector } from "@/lib/integrations/store";

export const runtime = "nodejs";

/** Most failed deliveries returned (newest first); older ones are pruned by the scheduler anyway. */
const LIST_LIMIT = 50;

/**
 * GET /api/integrations/connectors/[id]/deliveries?status=dead (Q-ACC-14,
 * admin only): the messages NoPM gave up on, so an admin sees what never
 * reached anyone and can retry it. Fields are the already-sanitised, truncated
 * bookkeeping only: never the payload, a token or a message body. Workspace +
 * connector filtered. Only `dead` (default) and `retry` can be listed.
 */
export const GET = route(async ({ actor, params, request }) => {
  assertIntegrationAdmin(actor);
  const connector = await getConnector(actor.workspaceId, params.id);
  if (!connector) throw new NotFoundError("Connector not found");

  const status = new URL(request.url).searchParams.get("status") === "retry" ? "retry" : "dead";
  const { data, error } = await createAdminClient()
    .from("integration_deliveries")
    .select("id, kind, approval_kind, approval_id, status, attempts, last_error, created_at, next_attempt_at")
    .eq("workspace_id", actor.workspaceId)
    .eq("connector_id", connector.id)
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) throw error;

  return ok(
    ((data ?? []) as Record<string, unknown>[]).map((d) => ({
      ...d,
      last_error: typeof d.last_error === "string" ? sanitizeError(d.last_error).slice(0, 300) : null,
    })),
  );
});

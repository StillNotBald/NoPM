import { route } from "@/lib/api/handler";
import { ApiError, NotFoundError, RuleError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { getAdapter } from "@/lib/integrations/deliveries";
import { sanitizeError } from "@/lib/integrations/secrets";
import { assertIntegrationAdmin, getConnector, loadConnectorSecrets } from "@/lib/integrations/store";

export const runtime = "nodejs";

/**
 * POST /api/integrations/connectors/[id]/test — cheap credential check (admin
 * only): asks the platform for the bot's own info with the stored app
 * credentials. A read-style probe — it changes nothing in NoPM, so by design it
 * writes no audit row (see the coverage allowlist). The result is always 200
 * with `ok` true/false; a platform error text is sanitised (no secrets) and
 * truncated before it is returned.
 */
export const POST = route(async ({ actor, params }) => {
  assertIntegrationAdmin(actor);

  const connector = await getConnector(actor.workspaceId, params.id);
  if (!connector) throw new NotFoundError("Connector not found");
  if (connector.status === "revoked") throw new RuleError("This connector is revoked", "connector_revoked");

  let secrets;
  try {
    secrets = loadConnectorSecrets(connector);
  } catch {
    return ok({ ok: false, error: "Stored credentials cannot be decrypted. Re-enter the app secret and verification token." });
  }

  const adapter = await getAdapter(connector.kind);
  if (!adapter) throw new ApiError(503, "The platform adapter is not available", "adapter_unavailable");

  const secretList = [secrets.appSecret, secrets.verificationToken, secrets.encryptKey];
  try {
    const result = await adapter.testConnection(connector, secrets);
    if (result.ok) return ok({ ok: true, bot_name: result.botName });
    return ok({ ok: false, error: sanitizeError(result.error, secretList) });
  } catch (err) {
    return ok({ ok: false, error: sanitizeError(err, secretList) });
  }
});

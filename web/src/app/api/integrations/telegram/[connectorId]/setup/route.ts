import { route } from "@/lib/api/handler";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { appBaseUrl, assertIntegrationAdmin } from "@/lib/integrations/store";
import { redact } from "@/lib/integrations/telegram/http";
import { readTelegramSecrets } from "@/lib/integrations/telegram/secrets";
import { registerTelegram } from "@/lib/integrations/telegram/setup";
import { getTelegramConnector } from "@/lib/integrations/telegram/store";

export const runtime = "nodejs";

/**
 * POST /api/integrations/telegram/[connectorId]/setup - register (or re-register)
 * the connector with Telegram: checks the bot token, calls setWebhook with the
 * connector's secret token and setMyCommands for the default scope (the member
 * menu; admins and managers get a per-chat menu once they link). Admin session
 * only. Idempotent and safe to repeat. It changes nothing in NoPM, so it writes
 * no audit row (a probe, like the connector test action). Always 200 with `ok`
 * true/false; the Telegram error text is truncated and has the token removed.
 */
export const POST = route(async ({ actor, params, request }) => {
  assertIntegrationAdmin(actor);
  const connector = await getTelegramConnector(actor.workspaceId, params.connectorId);
  if (!connector) throw new NotFoundError("Connector not found");
  if (connector.status === "revoked") throw new RuleError("This connector is revoked", "connector_revoked");

  const result = await registerTelegram(connector, appBaseUrl(new URL(request.url).origin));
  if (result.ok) return ok({ ok: true, bot_username: result.botUsername });
  let token: string | null = null;
  try {
    token = readTelegramSecrets(connector).botToken;
  } catch {
    token = null;
  }
  return ok({ ok: false, step: result.step, error: redact(result.error, token).slice(0, 300) });
});

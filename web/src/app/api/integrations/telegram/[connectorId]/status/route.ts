import { route } from "@/lib/api/handler";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { assertIntegrationAdmin, appBaseUrl } from "@/lib/integrations/store";
import { getWebhookInfo, redact } from "@/lib/integrations/telegram/http";
import { readTelegramSecrets, webhookUrl } from "@/lib/integrations/telegram/secrets";
import { getTelegramConnector, lastTelegramUpdateAt } from "@/lib/integrations/telegram/store";

export const runtime = "nodejs";

/**
 * GET /api/integrations/telegram/[connectorId]/status - is the webhook healthy?
 * Admin session only. Asks Telegram for the webhook state and reports
 * data = { webhook: "ok" | "error", detail, pending_updates, last_update_at }.
 * `ok` means Telegram has THIS connector's URL registered and no recent delivery
 * error; anything else is `error` with a short, token-free detail. Read only: no audit row.
 */
export const GET = route(async ({ actor, params, request }) => {
  assertIntegrationAdmin(actor);
  const connector = await getTelegramConnector(actor.workspaceId, params.connectorId);
  if (!connector) throw new NotFoundError("Connector not found");
  if (connector.status === "revoked") throw new RuleError("This connector is revoked", "connector_revoked");

  const lastUpdateAt = await lastTelegramUpdateAt(connector.id);
  let token: string | null = null;
  try {
    token = readTelegramSecrets(connector).botToken;
  } catch {
    return ok({ webhook: "error", detail: "Stored credentials cannot be decrypted. Disconnect and paste the bot token again.", pending_updates: null, last_update_at: lastUpdateAt });
  }
  const info = await getWebhookInfo(token);
  if (!info.ok) {
    return ok({ webhook: "error", detail: redact(info.error, token).slice(0, 200), pending_updates: null, last_update_at: lastUpdateAt });
  }
  const expected = webhookUrl(appBaseUrl(new URL(request.url).origin), connector.id);
  const lastError = info.result.last_error_message ? redact(String(info.result.last_error_message), token).slice(0, 200) : null;
  let detail: string | null = null;
  if (!info.result.url) detail = "Telegram has no webhook for this bot. Use Reconnect to register it.";
  else if (info.result.url !== expected) detail = "Telegram sends updates to a different address. Use Reconnect to register this one.";
  else if (lastError) detail = `Telegram's last delivery failed: ${lastError}`;
  return ok({
    webhook: detail ? "error" : "ok",
    detail,
    pending_updates: typeof info.result.pending_update_count === "number" ? info.result.pending_update_count : null,
    last_update_at: lastUpdateAt,
  });
});

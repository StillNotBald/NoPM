import { route } from "@/lib/api/handler";
import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { assertIntegrationAdmin } from "@/lib/integrations/store";
import { redact, sendMessage } from "@/lib/integrations/telegram/http";
import { readTelegramSecrets } from "@/lib/integrations/telegram/secrets";
import { findLinkedChatId, getTelegramConnector } from "@/lib/integrations/telegram/store";

export const runtime = "nodejs";

/**
 * POST /api/integrations/telegram/[connectorId]/test - send a short test message
 * to the calling admin's OWN linked Telegram chat (never to anyone else).
 * Admin session only. 422 `not_linked` when the admin has not linked Telegram
 * yet. Always 200 with data = { ok: true } or { ok: false, error } once a send
 * was attempted (the error has the token removed). Changes nothing in NoPM: no audit row.
 */
export const POST = route(async ({ actor, params }) => {
  assertIntegrationAdmin(actor);
  if (actor.type !== "user") throw new ScopeError("A test message needs a signed-in session");
  const connector = await getTelegramConnector(actor.workspaceId, params.connectorId);
  if (!connector) throw new NotFoundError("Connector not found");
  if (connector.status === "revoked") throw new RuleError("This connector is revoked", "connector_revoked");
  if (connector.status !== "active") throw new RuleError("The Telegram bot is paused. Resume it first.", "connector_paused");

  const chatId = await findLinkedChatId(actor.workspaceId, connector.id, actor.id);
  if (!chatId) throw new RuleError("Link your own Telegram account first, then send the test.", "not_linked");

  let token: string;
  try {
    token = readTelegramSecrets(connector).botToken;
  } catch {
    return ok({ ok: false, error: "Stored credentials cannot be decrypted. Disconnect and paste the bot token again." });
  }
  const res = await sendMessage(token, { chatId, text: "This is a test message from NoPM. The Telegram connection works." });
  return res.ok ? ok({ ok: true }) : ok({ ok: false, error: redact(res.error, token).slice(0, 200) });
});

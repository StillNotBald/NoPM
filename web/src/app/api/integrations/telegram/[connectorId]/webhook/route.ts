import { route } from "@/lib/api/handler";
import { handleTelegramWebhook } from "@/lib/integrations/telegram/webhook";
import { productionWebhookDeps } from "@/lib/integrations/telegram/wiring";

export const runtime = "nodejs";

/**
 * POST /api/integrations/telegram/[connectorId]/webhook - Telegram Bot API
 * update endpoint. Public (`auth:false`): the caller is Telegram, authenticated by
 * the per-connector secret token it echoes in `X-Telegram-Bot-Api-Secret-Token`
 * (compared in constant time; registered with setWebhook).
 *
 *   - a private-chat message or a button tap -> `{}` at once; the work runs after the response
 *   - group, channel and bot traffic         -> `{}` and no reply
 *
 * The body is Telegram's contract, not NoPM's `{ data }` envelope. Errors: 401 (a
 * wrong or missing secret, and an unknown or revoked connector, which look the
 * same), 404 (a malformed connector id only), 413, 429 (per-connector budget).
 */
export const POST = route(
  async ({ request, params }) => handleTelegramWebhook(request, params.connectorId ?? "", productionWebhookDeps()),
  { auth: false },
);

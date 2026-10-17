import { route } from "@/lib/api/handler";
import { handleLarkWebhook } from "@/lib/integrations/lark/http";
import { productionWebhookDeps } from "@/lib/integrations/lark/wiring";

export const runtime = "nodejs";

/**
 * POST /api/integrations/lark/[connectorId]/events - Lark / Feishu event
 * subscription endpoint (hosted "webhook" mode). Public (`auth:false`): the
 * caller is the platform, authenticated by the connector's verification token
 * and, when an Encrypt Key is configured, the signed + encrypted body.
 *
 *   - `url_verification` handshake      -> `{ challenge }`
 *   - `im.message.receive_v1` (bot DMs) -> `{}` at once; `help`, `link <code>`
 *     and `approvals` are answered afterwards as a DM from the bot
 *   - `card.action.trigger`             -> the card route's reply (so one URL
 *     pasted into both console fields also works)
 *   - anything else                     -> `{}`
 *
 * The body is the platform's contract, not NoPM's `{ data }` envelope. Errors:
 * 401 (any verification failure, and an unknown / paused / revoked connector,
 * which looks the same - one generic body), 403 wrong mode, 404 (a malformed
 * connector id only), 413, 429 (per-connector budget).
 */
export const POST = route(
  async ({ request, params }) => handleLarkWebhook(request, params.connectorId ?? "", productionWebhookDeps()),
  { auth: false },
);

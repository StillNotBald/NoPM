import { route } from "@/lib/api/handler";
import { handleLarkWebhook } from "@/lib/integrations/lark/http";
import { productionWebhookDeps } from "@/lib/integrations/lark/wiring";

export const runtime = "nodejs";

/**
 * POST /api/integrations/lark/[connectorId]/card - Lark / Feishu card
 * callback endpoint (`card.action.trigger`, hosted "webhook" mode). Public
 * (`auth:false`), authenticated exactly like the events route.
 *
 * The only mutation reachable from here is a human approve / reject: the
 * button's `{ t, a }` is handed to the hub's inbound pipeline, which maps the
 * platform-verified operator to a linked NoPM user, consumes the single-use
 * token and runs the same governed decision path as the console (four-eyes,
 * scopes, one audit row with channel `lark`).
 *
 * Replies HTTP 200 within the platform's 3 s deadline with
 * `{ toast: { type, content }, card?: { type: "raw", data } }` - the toast is
 * shown to the person, the card (if any) replaces the one they pressed. Even a
 * rate-limited or refused click gets a 200 toast. Verification failures are
 * 401, unknown / paused / revoked connectors 404, wrong mode 403.
 */
export const POST = route(
  async ({ request, params }) => handleLarkWebhook(request, params.connectorId ?? "", productionWebhookDeps()),
  { auth: false },
);

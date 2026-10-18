import { route } from "@/lib/api/handler";
import { handleGithubWebhook, productionGithubDeps } from "@/lib/integrations/github/http";

export const runtime = "nodejs";

/**
 * POST /api/integrations/github/[connectorId]/events - GitHub webhook endpoint (R-153). Public
 * (`auth:false`): the caller is GitHub, authenticated by `X-Hub-Signature-256` (HMAC-SHA256 of the raw body
 * under the connector's secret). Handles `pull_request` (opened, reopened, closed, merged) and
 * `deployment_status` (success, failure); `ping` and every other event answer 200 and change nothing.
 *
 * The body is GitHub's contract, not NoPM's `{ data }` envelope. Errors: 401 (any verification failure and
 * an unknown / paused / revoked connector, one generic body), 400 (a missing delivery id or unreadable JSON
 * after authentication), 404 (a malformed connector id only), 413, 429, 503 (nothing recorded; redeliver).
 * A recorded delivery always answers 200 `{ ok: true }`.
 */
export const POST = route(
  async ({ request, params }) => handleGithubWebhook(request, params.connectorId ?? "", productionGithubDeps()),
  { auth: false },
);

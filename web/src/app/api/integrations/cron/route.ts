import { route } from "@/lib/api/handler";
import { AuthError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { runCron, verifyCronAuth } from "@/lib/integrations/cron";

export const runtime = "nodejs";
// Retries + the weekly digest can take a few platform round trips.
export const maxDuration = 60;

/**
 * GET /api/integrations/cron — the daily scheduler tick (Vercel Cron, `0 1 * * *`
 * in vercel.json). NOT a user/token route (`auth: false`): the only credential
 * is `Authorization: Bearer $CRON_SECRET`, which Vercel attaches to its own cron
 * calls and which is compared in constant time. An unset CRON_SECRET authorises
 * nobody. It drains deliveries that are due for retry and posts each
 * connector's weekly digest on its configured weekday. Idempotent: a second
 * call the same day re-drains (leases prevent double sends) and never repeats
 * a digest.
 */
export const GET = route(
  async ({ request }) => {
    if (!verifyCronAuth(request.headers.get("authorization"))) {
      throw new AuthError("Invalid cron credentials");
    }
    return ok(await runCron());
  },
  { auth: false },
);

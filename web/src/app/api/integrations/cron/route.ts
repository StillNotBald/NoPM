import { route } from "@/lib/api/handler";
import { AuthError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { runCron, verifyCronAuth } from "@/lib/integrations/cron";

export const runtime = "nodejs";
// A literal: Next reads route segment config statically, so this cannot be
// imported. The tick stops STARTING work at CRON_DEADLINE_MS (40 s, lib/cron.ts)
// and one platform call is capped at 10 s, so the worst case ends well inside
// this budget. cron.test.ts asserts that relation; change them together.
export const maxDuration = 60;

/**
 * GET /api/integrations/cron — the daily scheduler tick (Vercel Cron, `7 1 * * *`
 * in vercel.json: 01:07 UTC, off the hour and half-hour because Lark sheds load
 * at :00/:30). NOT a user/token route (`auth: false`): the only credential is
 * `Authorization: Bearer $CRON_SECRET`, which Vercel attaches to its own cron
 * calls and which is compared in constant time. An unset CRON_SECRET authorises
 * nobody (and is logged, because it otherwise looks like a cron that merely
 * never runs). It drains deliveries that are due for retry, posts each
 * connector's weekly digest on its configured weekday, and prunes old
 * bookkeeping rows. Idempotent: a second call the same day re-drains (leases
 * prevent double sends) and never repeats a digest.
 */
export const GET = route(
  async ({ request }) => {
    if (!verifyCronAuth(request.headers.get("authorization"))) {
      if (!process.env.CRON_SECRET?.trim()) {
        console.error("[integrations] CRON_SECRET is not set: the scheduler endpoint refuses every call");
      }
      throw new AuthError("Invalid cron credentials");
    }
    return ok(await runCron());
  },
  { auth: false },
);

import { route } from "@/lib/api/handler";
import { AuthError } from "@/lib/api/errors";
import { ok } from "@/lib/api/response";
import { verifyCronAuth } from "@/lib/integrations/cron";
import { takeSnapshots } from "@/lib/insight/snapshots";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/cron/snapshots: the nightly project-snapshot tick (Vercel Cron, `37 17 * * *`
 * in vercel.json: 17:37 UTC, which is 01:37 the next day in the default Kuala Lumpur
 * zone, off the hour and half-hour). NOT a user/token route (`auth: false`): the only
 * credential is `Authorization: Bearer $CRON_SECRET`, compared in constant time, the
 * same check as the integrations cron. An unset CRON_SECRET authorises nobody.
 *
 * Takes one snapshot per project per workspace day (SPI, CPI, EAC, slip, completion,
 * open high risks, declared and suggested RAG) and writes ONE `snapshot.taken` audit
 * row per workspace per run. Idempotent: a second call the same day inserts nothing.
 */
export const GET = route(
  async ({ request }) => {
    if (!verifyCronAuth(request.headers.get("authorization"))) {
      if (!process.env.CRON_SECRET?.trim()) {
        console.error("[snapshots] CRON_SECRET is not set: the snapshot endpoint refuses every call");
      }
      throw new AuthError("Invalid cron credentials");
    }
    return ok(await takeSnapshots());
  },
  { auth: false },
);

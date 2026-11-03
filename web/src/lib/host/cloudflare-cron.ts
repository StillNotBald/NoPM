/**
 * Cron mapping for the Cloudflare Workers host (ADR 0021).
 *
 * Vercel reads `crons` from vercel.json and calls each route with
 * `Authorization: Bearer $CRON_SECRET`. A Worker has no such scheduler: Cloudflare
 * Cron Triggers call a `scheduled()` handler with the cron expression that fired.
 * This module is the pure part of that handler: expression -> route -> request.
 * `cloudflare/worker.ts` wires it to the OpenNext fetch handler.
 *
 * The routes are untouched: they already verify the bearer secret in constant
 * time (`verifyCronAuth`). The expressions here MUST equal vercel.json and
 * wrangler.jsonc `triggers.crons`; `cloudflare-cron.test.ts` fails if they drift.
 */

export const CRON_ROUTES: Readonly<Record<string, string>> = {
  "7 1 * * *": "/api/integrations/cron",
  "37 17 * * *": "/api/cron/snapshots",
};

/** Origin used only to build an absolute URL for the in-process call; no network hop uses it. */
const FALLBACK_ORIGIN = "https://nopm-web.invalid";

export type CronEnv = {
  CRON_SECRET?: string;
  NEXT_PUBLIC_APP_URL?: string;
};

export type CronResult =
  | { ran: true; path: string; status: number }
  | { ran: false; reason: "unknown-expression" | "no-secret" | "error"; path?: string };

export function resolveCronRoute(expression: string): string | null {
  return Object.prototype.hasOwnProperty.call(CRON_ROUTES, expression) ? CRON_ROUTES[expression] : null;
}

/**
 * Run the route for a fired cron expression. `dispatch` is the OpenNext fetch
 * handler bound to the Worker env and context, so the call stays in-process.
 *
 * Logs the expression, path and status only. The secret and the response body
 * are never logged. An unknown expression is a logged no-op (it can only mean
 * wrangler.jsonc and this file disagree). Never throws: a failed tick must not
 * mask the real error in the Workers log, and the jobs are idempotent.
 */
export async function runScheduled(
  expression: string,
  env: CronEnv,
  dispatch: (request: Request) => Promise<Response>,
  log: Pick<Console, "log" | "warn" | "error"> = console,
): Promise<CronResult> {
  const path = resolveCronRoute(expression);
  if (!path) {
    log.warn(`[cron] no route for cron expression "${expression}"; nothing ran`);
    return { ran: false, reason: "unknown-expression" };
  }
  const secret = env.CRON_SECRET?.trim();
  if (!secret) {
    log.error(`[cron] CRON_SECRET is not set; ${path} would refuse the call, so it was not made`);
    return { ran: false, reason: "no-secret", path };
  }
  const origin = originOf(env.NEXT_PUBLIC_APP_URL);
  try {
    const res = await dispatch(new Request(`${origin}${path}`, { method: "GET", headers: { authorization: `Bearer ${secret}` } }));
    // Drain the body so the connection is released; the content is not logged.
    await res.arrayBuffer().catch(() => undefined);
    if (res.ok) log.log(`[cron] ${path} -> ${res.status}`);
    else log.error(`[cron] ${path} -> ${res.status}`);
    return { ran: true, path, status: res.status };
  } catch (err) {
    log.error(`[cron] ${path} failed: ${err instanceof Error ? err.name : "error"}`);
    return { ran: false, reason: "error", path };
  }
}

function originOf(raw: string | undefined): string {
  try {
    return raw ? new URL(raw.trim()).origin : FALLBACK_ORIGIN;
  } catch {
    return FALLBACK_ORIGIN;
  }
}

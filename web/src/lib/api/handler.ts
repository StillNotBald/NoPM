import { NextRequest } from "next/server";
import { type Actor, requireAuth } from "@/lib/auth/guard";
import { invalidInputError, toErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin } from "@/lib/api/origin";
import { checkRateLimit } from "@/lib/api/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveRequestId } from "@/lib/audit/channel";

export type RouteCtx = {
  request: NextRequest;
  actor: Actor;
  params: Record<string, string>;
};

/**
 * Wrap a route handler with auth + rate limiting + uniform error handling.
 * - resolves the Actor (session or Bearer PAT) unless { auth: false }
 * - refuses a cookie-session POST/PUT/PATCH/DELETE whose Origin names another
 *   site (403 bad_origin, @/lib/api/origin). Bearer-token requests and the
 *   { auth: false } routes (Lark webhook / relay / card, cron, invite accept,
 *   calendar feeds), none of which use the session cookie, are not checked.
 * - applies the baseline DB-backed rate limit AFTER actor resolution, before
 *   the handler runs (@/lib/api/rate-limit — fail-open+audited, 429 contract)
 * - awaits Next 16 async `params`
 * - converts thrown ApiErrors (including RateLimitError) into the { error }
 *   contract, maps a malformed id / value (Postgres 22P02) to 404 (path id) or
 *   422 instead of a 500, else a sanitized 500
 *
 * Routes NOT built on route() — /api/health, /api/openapi.json, /llms.txt,
 * and the auth endpoints under /api/auth/** that pre-date this wrapper — are
 * naturally out of scope for rate limiting; they are public/liveness surfaces
 * with no workspace-scoped actor to key a limiter on.
 */
export function route(
  handler: (ctx: RouteCtx) => Promise<Response> | Response,
  opts: { auth?: boolean } = {},
) {
  return async (
    request: NextRequest,
    context: { params?: Promise<Record<string, string>> },
  ): Promise<Response> => {
    // Resolved outside the try so a thrown error AFTER auth (e.g. the
    // handler body, or a rate-limit RuleError) can still stamp the
    // request-id correlation header on the error response below.
    let actor: Actor | undefined;
    let params: Record<string, string> = {};
    try {
      params = context?.params ? await context.params : {};
      actor = opts.auth === false ? undefined : await requireAuth(request);
      // A session actor is authenticated by an ambient cookie; a token is not.
      if (actor?.type === "user") assertSameOrigin(request);
      if (opts.auth !== false && actor) {
        await checkRateLimit(createAdminClient(), actor, request);
      }
      const response = await handler({ request, actor: actor as Actor, params });
      if (actor?.requestId) stampRequestId(response, actor.requestId);
      return response;
    } catch (error) {
      const response = toErrorResponse(invalidInputError(error, Object.values(params)) ?? error);
      if (actor?.requestId) {
        stampRequestId(response, actor.requestId);
      } else if (opts.auth !== false) {
        // R-84: auth failed (requireAuth threw) before an Actor ever
        // resolved, so there is no actor.requestId to stamp — but the
        // failure is still one HTTP request and deserves one correlation
        // id. Resolve it straight from the incoming headers (same echo-or-
        // generate rule resolveClientMeta uses) so a 401 is just as
        // traceable as any successful call. Skipped for auth:false routes,
        // which never had an actor to correlate in the first place and
        // stamp nothing today by design.
        stampRequestId(response, resolveRequestId(request.headers));
      }
      return response;
    }
  };
}

/**
 * Stamp X-Request-Id on a response — best-effort: some Response shapes (e.g.
 * a Response built from a ReadableStream body, or one whose headers were
 * frozen by the runtime) throw on `.headers.set`, so this never lets a
 * header-stamping failure mask the real response.
 */
function stampRequestId(response: Response, requestId: string): void {
  try {
    response.headers.set("X-Request-Id", requestId);
  } catch {
    // Immutable headers (e.g. some streamed responses) — not fatal.
  }
}

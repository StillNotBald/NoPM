import { NextRequest } from "next/server";
import { type Actor, requireAuth } from "@/lib/auth/guard";
import { toErrorResponse } from "@/lib/api/errors";
import { checkRateLimit } from "@/lib/api/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

export type RouteCtx = {
  request: NextRequest;
  actor: Actor;
  params: Record<string, string>;
};

/**
 * Wrap a route handler with auth + rate limiting + uniform error handling.
 * - resolves the Actor (session or Bearer PAT) unless { auth: false }
 * - applies the baseline DB-backed rate limit AFTER actor resolution, before
 *   the handler runs (@/lib/api/rate-limit — fail-open+audited, 429 contract)
 * - awaits Next 16 async `params`
 * - converts thrown ApiErrors (including RateLimitError) into the { error }
 *   contract, else a sanitized 500
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
    try {
      const params = context?.params ? await context.params : {};
      actor = opts.auth === false ? undefined : await requireAuth(request);
      if (opts.auth !== false && actor) {
        await checkRateLimit(createAdminClient(), actor, request);
      }
      const response = await handler({ request, actor: actor as Actor, params });
      stampRequestId(response, actor);
      return response;
    } catch (error) {
      const response = toErrorResponse(error);
      stampRequestId(response, actor);
      return response;
    }
  };
}

/**
 * Stamp X-Request-Id on a response from the resolved actor's correlation id
 * (R-82) — best-effort: some Response shapes (e.g. a Response built from a
 * ReadableStream body, or one whose headers were frozen by the runtime)
 * throw on `.headers.set`, so this never lets a header-stamping failure
 * mask the real response.
 */
function stampRequestId(response: Response, actor: Actor | undefined): void {
  if (!actor?.requestId) return;
  try {
    response.headers.set("X-Request-Id", actor.requestId);
  } catch {
    // Immutable headers (e.g. some streamed responses) — not fatal.
  }
}

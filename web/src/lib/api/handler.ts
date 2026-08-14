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
    try {
      const params = context?.params ? await context.params : {};
      const actor =
        opts.auth === false ? (undefined as unknown as Actor) : await requireAuth(request);
      if (opts.auth !== false) {
        await checkRateLimit(createAdminClient(), actor, request);
      }
      return await handler({ request, actor, params });
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

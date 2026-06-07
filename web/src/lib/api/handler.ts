import { NextRequest } from "next/server";
import { type Actor, requireAuth } from "@/lib/auth/guard";
import { toErrorResponse } from "@/lib/api/errors";

export type RouteCtx = {
  request: NextRequest;
  actor: Actor;
  params: Record<string, string>;
};

/**
 * Wrap a route handler with auth + uniform error handling.
 * - resolves the Actor (session or Bearer PAT) unless { auth: false }
 * - awaits Next 16 async `params`
 * - converts thrown ApiErrors into the { error } contract, else a sanitized 500
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
      return await handler({ request, actor, params });
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

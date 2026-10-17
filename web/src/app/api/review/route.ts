import { NextResponse } from "next/server";
import { route } from "@/lib/api/handler";
import { validationError } from "@/lib/api/response";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  PENDING_KINDS,
  listPendingApprovals,
  type PendingKind,
} from "@/lib/review/pending";

export const runtime = "nodejs";

/**
 * GET /api/review
 * "What is waiting for me?" — every governed decision currently pending in the
 * actor's workspace, oldest first, across deletion requests (task + project),
 * change requests (raised / under_review)
 * and rebaselines (pending_approval). READ-ONLY: it exposes no way to decide
 * anything — each item says whether the caller `can_decide` it (scope +
 * four-eyes, by person) and `reason_if_not`, then the existing decision
 * routes / `nopm approve` / the console do the deciding.
 *
 * Auth: any authenticated actor. A session user sees every kind; a Bearer
 * token sees the kinds it can read through each family's own list endpoint
 * (task:read | audit:read for deletions, change:read,
 * project:read) and `hidden_kinds` names the rest. A token holding none of
 * them gets 403. Query logic lives in @/lib/review/pending.
 *
 * Query: ?kind=<comma list of task_deletion|project_deletion|change_request|
 * rebaseline> · ?page (default 1) · ?limit (1..200, default 50).
 * Response: { data: PendingItem[], total, page, limit, hidden_kinds }.
 */
export const GET = route(async ({ actor, request }) => {
  const { searchParams } = new URL(request.url);

  const rawLimit = parseInt(searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isNaN(rawLimit) ? DEFAULT_LIMIT : rawLimit));
  const rawPage = parseInt(searchParams.get("page") ?? "1", 10);
  const page = Math.max(1, Number.isNaN(rawPage) ? 1 : rawPage);

  const kindParam = searchParams.getAll("kind").flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  const unknown = kindParam.filter((k) => !(PENDING_KINDS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    return validationError("Unknown kind", [
      { field: "kind", message: `Unknown: ${unknown.join(", ")}. Allowed: ${PENDING_KINDS.join(", ")}` },
    ]);
  }

  const result = await listPendingApprovals(
    createAdminClient(),
    // Only what the query layer needs; it filters every query by workspaceId
    // (the admin client bypasses RLS for token callers).
    { type: actor.type, id: actor.id, workspaceId: actor.workspaceId, principalId: actor.principalId },
    // requireScope is the single source of truth for scope rules (wildcards,
    // privileged scopes, viewer read-only); turn its throw into a reason string.
    (scope) => {
      try {
        requireScope(actor, scope);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : "Insufficient scope";
      }
    },
    { page, limit, kinds: kindParam.length > 0 ? (kindParam as PendingKind[]) : undefined },
  );

  return NextResponse.json({
    data: result.items,
    total: result.total,
    page: result.page,
    limit: result.limit,
    hidden_kinds: result.hidden_kinds,
  });
});

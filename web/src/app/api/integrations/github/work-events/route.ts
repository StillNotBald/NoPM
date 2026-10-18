import { route } from "@/lib/api/handler";
import { ApiError } from "@/lib/api/errors";
import { okList } from "@/lib/api/response";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

/**
 * GET /api/integrations/github/work-events - the latest GitHub work events the workspace received
 * (R-153), newest first, each with whether it moved a task and why not when it did not. Workspace-filtered,
 * signed-in sessions only. `limit` 1-50 (default 20).
 */
export const GET = route(async ({ actor, request }) => {
  if (actor.type !== "user") throw new ApiError(403, "GitHub work events are available to signed-in users", "forbidden");
  const raw = Number(new URL(request.url).searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(raw) && raw >= 1 ? Math.min(raw, MAX_LIMIT) : DEFAULT_LIMIT;

  const { data, error } = await createAdminClient()
    .from("work_events")
    .select("id, kind, repo, ref, actor_login, task_id, received_at, applied, applied_status, reason")
    .eq("workspace_id", actor.workspaceId)
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const items = data ?? [];
  return okList(items, { total: items.length, page: 1, limit });
});

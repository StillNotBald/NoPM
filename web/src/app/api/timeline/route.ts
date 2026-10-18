import { route } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { gatherTimeline } from "@/lib/timeline/gather";

export const runtime = "nodejs";

/**
 * GET /api/timeline — the Mainline portfolio graph (one governed read assembling
 * every artifact across the workspace). Read-only; workspace-scoped.
 */
export const GET = route(async ({ actor }) => {
  requireScope(actor, "project:read");
  const db = createAdminClient();
  const graph = await gatherTimeline(db, actor.workspaceId);
  return ok(graph);
});

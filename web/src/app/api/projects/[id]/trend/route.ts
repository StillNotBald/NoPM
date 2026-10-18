import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { ok } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { computeTrend, MAX_TREND_WINDOW, TREND_THRESHOLDS, TREND_WINDOW, type SnapshotPoint } from "@/lib/insight/trend";

export const runtime = "nodejs";

/**
 * GET /api/projects/:id/trend: the stored daily snapshots of one project (oldest
 * first, last `n`, default 28, max 120) and the trend computed from them: slip in
 * days per week, SPI and CPI direction, and a SUGGESTED RAG with the reason. The
 * suggestion is advice shown beside the declared RAG; it never changes it.
 * Read-only and derived: nothing is written or audited.
 */
export const GET = route(async ({ actor, params, request }) => {
  requireScope(actor, "project:read");
  const db = createAdminClient();

  const { data: project } = await db
    .from("projects")
    .select("id, rag_status")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();
  if (!project) throw new NotFoundError("Project not found");

  const raw = parseInt(new URL(request.url).searchParams.get("n") ?? String(TREND_WINDOW), 10);
  const n = Math.min(MAX_TREND_WINDOW, Math.max(1, Number.isNaN(raw) ? TREND_WINDOW : raw));

  const { data, error } = await db
    .from("project_snapshots")
    .select("taken_at, spi, cpi, eac, planned_end, forecast_end, slip_days, completion_pct, open_risks_high, rag_declared, rag_suggested")
    .eq("workspace_id", actor.workspaceId)
    .eq("project_id", params.id)
    .order("taken_at", { ascending: false })
    .limit(n);
  if (error) throw new Error(error.message);

  const series = ((data ?? []) as Array<SnapshotPoint & Record<string, unknown>>).reverse();
  const trend = computeTrend(series, n);

  return ok({
    project_id: params.id,
    declared_rag: project.rag_status ?? null,
    suggested_rag: trend.suggested_rag,
    reason: trend.reason,
    confidence: trend.confidence,
    trend,
    thresholds: TREND_THRESHOLDS,
    series,
  });
});

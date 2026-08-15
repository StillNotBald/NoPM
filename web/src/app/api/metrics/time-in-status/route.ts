import { route } from "@/lib/api/handler";
import { ok, validationError } from "@/lib/api/response";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { z } from "zod";
import { fetchTaskTransitions, timeInStatus } from "@/lib/insight/flow";

export const runtime = "nodejs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const querySchema = z
  .object({
    task_id: z.string().uuid().optional(),
    project_id: z.string().uuid().optional(),
    date_from: z.string().regex(DATE_RE, "Expected YYYY-MM-DD").optional(),
    date_to: z.string().regex(DATE_RE, "Expected YYYY-MM-DD").optional(),
    limit: z
      .string()
      .optional()
      .transform((v) => (v !== undefined ? parseInt(v, 10) : 50))
      .pipe(z.number().int().min(1).max(100)),
  })
  .strict();

/**
 * GET /api/metrics/time-in-status — per-task status-span history (L-26),
 * read aggregate over the workspace's task audit trail. scope: task:read
 * (this is task-shaped data, same governance boundary as GET /api/tasks —
 * no new scope was minted for it). Shell copied from GET /api/timeline.
 *
 * Filters: ?task_id, ?project_id narrow the task set (no match -> {data:[]},
 * never a 404 — these are filters, not path lookups). ?date_from/?date_to
 * bound the ENTERED_AT of returned spans (YYYY-MM-DD, inclusive whole-day),
 * not the task set. ?limit caps how many tasks are considered (default 50,
 * max 100) when neither task_id nor project_id narrows the set.
 */
export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "task:read");

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join(".") || "query", message: e.message })),
    );
  }
  const { task_id, project_id, date_from, date_to, limit } = parsed.data;

  const db = createAdminClient();

  let taskQuery = db
    .from("tasks")
    .select("id")
    .eq("workspace_id", actor.workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (task_id) taskQuery = taskQuery.eq("id", task_id);
  if (project_id) taskQuery = taskQuery.eq("project_id", project_id);

  const { data: taskRows, error: taskError } = await taskQuery;
  if (taskError) throw taskError;

  const taskIds = (taskRows ?? []).map((t) => t.id as string);
  if (taskIds.length === 0) return ok([]);

  const transitionsByTask = await fetchTaskTransitions(db, actor.workspaceId, taskIds);

  const fromMs = date_from ? new Date(`${date_from}T00:00:00.000Z`).getTime() : undefined;
  const toMs = date_to ? new Date(`${date_to}T23:59:59.999Z`).getTime() : undefined;

  const data = taskIds.map((id) => {
    const spans = timeInStatus(transitionsByTask.get(id) ?? []);
    const filtered = spans.filter((s) => {
      if (fromMs === undefined && toMs === undefined) return true;
      const enteredMs = new Date(s.entered_at).getTime();
      if (fromMs !== undefined && enteredMs < fromMs) return false;
      if (toMs !== undefined && enteredMs > toMs) return false;
      return true;
    });
    return { task_id: id, spans: filtered };
  });

  return ok(data);
});

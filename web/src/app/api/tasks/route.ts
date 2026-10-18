import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { okList } from "@/lib/api/response";
import { createAdminClient } from "@/lib/supabase/admin";
import { workspaceToday } from "@/lib/integrations/time-zone";
import { parseSort, orderOptions } from "@/lib/api/sort";
import { TASK_SORT_FIELDS, parseTaskFilters } from "./_query";

export const runtime = "nodejs";

/**
 * GET /api/tasks — cross-project task list (L-04), scoped to the whole
 * workspace rather than one project. Filters: project_id, assignee_id,
 * status_type, priority, due_before, due_after, overdue=true, q (name ilike),
 * source, external_ref (complement seam, R-81 — both exact-match).
 * Sort: ?sort=field:asc|desc against a whitelist (L-10) — anything else 422s.
 * Paginated (default 20, max 100).
 */
export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "task:read");

  const db = createAdminClient();
  const url = new URL(request.url);

  const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const rawPage = parseInt(url.searchParams.get("page") ?? "1", 10);
  const limit = Math.min(100, Math.max(1, isNaN(rawLimit) ? 20 : rawLimit));
  const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
  const offset = (page - 1) * limit;

  // Reject an unknown sort field/direction before touching the DB.
  const sort = parseSort(url.searchParams.get("sort"), TASK_SORT_FIELDS, {
    field: "due_date",
    ascending: true,
  });

  const filters = parseTaskFilters(url.searchParams);
  // Workspace-zone date; only looked up when the overdue filter needs it.
  const todayIso = filters.overdue ? await workspaceToday(actor.workspaceId) : "";

  let query = db
    .from("tasks")
    .select("*", { count: "exact" })
    .eq("workspace_id", actor.workspaceId);

  // Inlined (not applyTaskFilters<Q>/applySort<Q>): the generic helpers trip
  // TS2589 against the concrete builder type — same workaround as every other
  // register route. parseTaskFilters/parseSort stay the single source of truth
  // (unit-locked in _query.test.ts / sort.test.ts).
  if (filters.project_id) query = query.eq("project_id", filters.project_id);
  if (filters.assignee_id) query = query.eq("assignee_id", filters.assignee_id);
  if (filters.status_type) query = query.eq("status_type", filters.status_type);
  if (filters.priority) query = query.eq("priority", filters.priority);
  if (filters.due_before) query = query.lte("due_date", filters.due_before);
  if (filters.due_after) query = query.gte("due_date", filters.due_after);
  if (filters.overdue) {
    query = query.lt("due_date", todayIso);
    query = query.not("status_type", "in", '("completed","canceled")');
  }
  if (filters.q) query = query.ilike("name", `%${filters.q}%`);
  if (filters.source) query = query.eq("source", filters.source);
  if (filters.external_ref) query = query.eq("external_ref", filters.external_ref);
  query = query.order(sort.field, orderOptions(sort));
  query = query.range(offset, offset + limit - 1);

  const { data: items, error, count } = await query;

  if (error) throw new Error(error.message);

  return okList(items ?? [], { total: count ?? 0, page, limit });
});

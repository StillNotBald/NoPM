import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { okList, created, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { createTimeEntrySchema } from "./_schema";
import { parseTimeEntryFilters, resolveBillable } from "./_query";

export const runtime = "nodejs";

export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "time:read");
  const db = createAdminClient();

  const url = new URL(request.url);
  const filters = parseTimeEntryFilters(url.searchParams);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const rawPage = parseInt(url.searchParams.get("page") ?? "1", 10);
  const limit = Math.min(100, Math.max(1, isNaN(rawLimit) ? 20 : rawLimit));
  const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
  const offset = (page - 1) * limit;

  let query = db
    .from("time_entries")
    .select("*", { count: "exact" })
    .eq("workspace_id", actor.workspaceId);

  // Applied inline rather than via the generic applyTimeEntryFilters<Q>
  // helper (still used by GET /api/export, which builds its own query the
  // same way) — chaining that generic against this route's already-concrete
  // Supabase builder type blows past TS's type-instantiation depth limit
  // (TS2589). parseTimeEntryFilters is still the single source of truth
  // for which query params are honored; only the mechanical .eq()
  // application is duplicated here.
  if (filters.project_id !== undefined) query = query.eq("project_id", filters.project_id);
  if (filters.member_id !== undefined) query = query.eq("member_id", filters.member_id);
  if (filters.date_from !== undefined) query = query.gte("entry_date", filters.date_from);
  if (filters.date_to !== undefined) query = query.lte("entry_date", filters.date_to);
  if (filters.billable !== undefined) query = query.eq("billable", filters.billable);

  const { data: items, count, error } = await query
    .order("entry_date", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(`Time entries query failed: ${error.message}`);

  return okList(items ?? [], { total: count ?? 0, page, limit });
});

export const POST = route(async ({ actor, request }) => {
  requireScope(actor, "time:write");
  const db = createAdminClient();

  const body = await safeJson(request);
  const parsed = createTimeEntrySchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  // Verify project belongs to workspace (also fetch default_billable — L-29)
  const { data: project } = await db
    .from("projects")
    .select("id, default_billable")
    .eq("id", parsed.data.project_id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();
  if (!project) throw new NotFoundError("Project not found");

  // Verify member belongs to workspace and look up cost_rate
  const { data: member } = await db
    .from("resource_members")
    .select("id, cost_rate")
    .eq("id", parsed.data.member_id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();
  if (!member) throw new NotFoundError("Resource member not found");

  // cost = hours * cost_rate (default cost_rate to 0 if null)
  const costRate: number = member.cost_rate ?? 0;
  const cost = parsed.data.hours * costRate;

  // L-29: explicit billable wins; else fall back to the project's default_billable.
  const billable = resolveBillable(parsed.data.billable, project.default_billable);

  const { data: row, error } = await db
    .from("time_entries")
    .insert({
      workspace_id: actor.workspaceId,
      member_id: parsed.data.member_id,
      task_id: parsed.data.task_id ?? null,
      project_id: parsed.data.project_id,
      entry_date: parsed.data.entry_date,
      hours: parsed.data.hours,
      cost,
      note: parsed.data.note ?? null,
      billable,
    })
    .select()
    .single();

  if (error || !row) {
    throw new Error(`Time entry insert failed: ${error?.message ?? "no row returned"}`);
  }

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "time.create",
    targetType: "time_entry",
    targetId: row.id,
    before: null,
    after: row,
  });

  return created(row);
});

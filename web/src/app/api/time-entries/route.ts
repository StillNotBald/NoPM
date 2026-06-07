import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { okList, created, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { createTimeEntrySchema } from "./_schema";

export const runtime = "nodejs";

export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "time:read");
  const db = createAdminClient();

  const url = new URL(request.url);
  const projectId = url.searchParams.get("project_id");
  const memberId = url.searchParams.get("member_id");
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const rawPage = parseInt(url.searchParams.get("page") ?? "1", 10);
  const limit = Math.min(100, Math.max(1, isNaN(rawLimit) ? 20 : rawLimit));
  const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
  const offset = (page - 1) * limit;

  let query = db
    .from("time_entries")
    .select("*", { count: "exact" })
    .eq("workspace_id", actor.workspaceId)
    .order("entry_date", { ascending: false })
    .range(offset, offset + limit - 1);

  if (projectId) query = query.eq("project_id", projectId);
  if (memberId) query = query.eq("member_id", memberId);

  const { data: items, count, error } = await query;

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

  // Verify project belongs to workspace
  const { data: project } = await db
    .from("projects")
    .select("id")
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

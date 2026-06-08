import { route } from "@/lib/api/handler";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { notify, resolveProjectOwner } from "@/lib/notify/publish";
import { createChangeRequestSchema } from "@/app/api/change-requests/_schema";

export const runtime = "nodejs";

/** Derive the next CR-NNN reference_id for a workspace. */
async function nextCrRefId(
  db: ReturnType<typeof createAdminClient>,
  workspaceId: string,
): Promise<string> {
  const { data, error } = await db
    .from("change_requests")
    .select("reference_id")
    .eq("workspace_id", workspaceId)
    .not("reference_id", "is", null);

  if (error) throw new Error(`nextCrRefId: ${error.message}`);

  let maxNum = 0;
  if (data && data.length > 0) {
    for (const row of data) {
      const val = row.reference_id as string | null;
      if (!val) continue;
      const dashIdx = val.lastIndexOf("-");
      if (dashIdx === -1) continue;
      const num = parseInt(val.slice(dashIdx + 1), 10);
      if (!isNaN(num) && num > maxNum) maxNum = num;
    }
    if (maxNum === 0) maxNum = data.length;
  }

  return `CR-${String(maxNum + 1).padStart(3, "0")}`;
}

/** GET /api/projects/:id/change-requests — list change requests for a project */
export const GET = route(async ({ actor, params, request }) => {
  requireScope(actor, "change:read");

  const db = createAdminClient();
  const projectId = params.id;

  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (!project) throw new NotFoundError("Project not found");

  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const rawPage = parseInt(url.searchParams.get("page") ?? "1", 10);
  const limit = Math.min(100, Math.max(1, isNaN(rawLimit) ? 20 : rawLimit));
  const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
  const offset = (page - 1) * limit;

  const { data: items, error, count } = await db
    .from("change_requests")
    .select("*", { count: "exact" })
    .eq("workspace_id", actor.workspaceId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message);

  return okList(items ?? [], { total: count ?? 0, page, limit });
});

/** POST /api/projects/:id/change-requests — raise a change request under a project */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "change:write");

  const db = createAdminClient();
  const projectId = params.id;

  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (!project) throw new NotFoundError("Project not found");

  const body = await safeJson(request);
  const parsed = createChangeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return validationError("Validation failed", parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    })));
  }

  const input = parsed.data;
  const refId = await nextCrRefId(db, actor.workspaceId);

  const { data: row, error } = await db
    .from("change_requests")
    .insert({
      workspace_id: actor.workspaceId,
      project_id: projectId,
      reference_id: refId,
      title: input.title,
      description: input.description ?? null,
      category: input.category,
      priority: input.priority,
      status: input.status,
      impact_summary: input.impact_summary ?? null,
      impact_schedule_days: input.impact_schedule_days ?? null,
      impact_cost: input.impact_cost ?? null,
      target_date: input.target_date ?? null,
      raised_at: input.raised_at ?? null,
      requested_by: actor.type === "user" ? actor.id : null,
      requested_by_label: actor.label,
    })
    .select()
    .single();

  if (error || !row) throw new Error(error?.message ?? "Insert failed");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "change_request.create",
    targetType: "change_request",
    targetId: row.id,
    before: null,
    after: row,
  });

  // Notify project owner when priority is high or critical — fail-soft
  if (input.priority === "high" || input.priority === "critical") {
    void resolveProjectOwner(actor.workspaceId, projectId).then((ownerId) => {
      if (!ownerId) return;
      return notify({
        workspaceId: actor.workspaceId,
        recipientIds: [ownerId],
        type: "risk.escalated",
        title: `${input.priority.toUpperCase()} change request raised: ${input.title}`,
        body: input.description ?? undefined,
        payload: { changeRequestId: row.id, projectId, priority: input.priority, refId: row.reference_id },
      });
    });
  }

  return created(row);
});

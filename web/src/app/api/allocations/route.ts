import { z } from "zod";
import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { ok, okList, created, safeJson, validationError } from "@/lib/api/response";
import { writeAudit } from "@/lib/audit/write";
import { notify, resolveWorkspaceApprovers } from "@/lib/notify/publish";
import { createAdminClient } from "@/lib/supabase/admin";
import { detectOverAllocation } from "@/lib/clash/detect";

export const runtime = "nodejs";

const createAllocationSchema = z.object({
  member_id: z.string().uuid(),
  project_id: z.string().uuid().optional().nullable(),
  task_id: z.string().uuid().optional().nullable(),
  allocation_pct: z.number().min(0).max(500).optional().nullable(),
  hours: z.number().nonnegative().optional().nullable(),
  window_start: z.string().datetime().optional().nullable(),
  window_end: z.string().datetime().optional().nullable(),
});

export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "resource:read");

  const { searchParams } = new URL(request.url);
  const rawLimit = parseInt(searchParams.get("limit") ?? "20", 10);
  const limit = Math.min(100, Math.max(1, isNaN(rawLimit) ? 20 : rawLimit));
  const rawPage = parseInt(searchParams.get("page") ?? "1", 10);
  const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
  const offset = (page - 1) * limit;

  const db = createAdminClient();

  const { count } = await db
    .from("allocations")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", actor.workspaceId);

  const { data, error } = await db
    .from("allocations")
    .select("*")
    .eq("workspace_id", actor.workspaceId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  return okList(data ?? [], { total: count ?? 0, page, limit });
});

export const POST = route(async ({ actor, request }) => {
  requireScope(actor, "resource:write");

  const body = await safeJson(request);
  const parsed = createAllocationSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid allocation payload",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const db = createAdminClient();
  const { data: row, error } = await db
    .from("allocations")
    .insert({
      ...parsed.data,
      workspace_id: actor.workspaceId,
    })
    .select()
    .single();

  if (error) throw error;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "allocation.create",
    targetType: "allocation",
    targetId: row.id,
    before: null,
    after: row,
  });

  // Detect over-allocation after writing the new allocation
  const clashDetected = await detectOverAllocation(db, actor.workspaceId, parsed.data.member_id, actor);

  // Notify workspace approvers when a clash is detected — fail-soft
  if (clashDetected) {
    void resolveWorkspaceApprovers(actor.workspaceId).then((approverIds) => {
      return notify({
        workspaceId: actor.workspaceId,
        recipientIds: approverIds,
        type: "clash.detected",
        title: `Over-allocation clash detected`,
        body: `A resource over-allocation clash was detected after a new allocation was created.`,
        payload: { memberId: parsed.data.member_id, allocationId: row.id },
      });
    });
  }

  return created(row);
});

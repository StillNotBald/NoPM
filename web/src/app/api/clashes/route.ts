import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { okList, created, safeJson, validationError } from "@/lib/api/response";
import { writeAudit } from "@/lib/audit/write";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClashSchema } from "./_schema";
import { nextRefId } from "@/lib/ref-id";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";

export const runtime = "nodejs";

export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "clash:read");

  const { searchParams } = new URL(request.url);
  const rawLimit = parseInt(searchParams.get("limit") ?? "20", 10);
  const limit = Math.min(100, Math.max(1, isNaN(rawLimit) ? 20 : rawLimit));
  const rawPage = parseInt(searchParams.get("page") ?? "1", 10);
  const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
  const offset = (page - 1) * limit;

  const db = createAdminClient();

  const { count } = await db
    .from("clashes")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", actor.workspaceId);

  const { data, error } = await db
    .from("clashes")
    .select("*")
    .eq("workspace_id", actor.workspaceId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  return okList(data ?? [], { total: count ?? 0, page, limit });
});

export const POST = route(async ({ actor, request }) => {
  requireScope(actor, "clash:write");

  const body = await safeJson(request);
  const parsed = createClashSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid clash payload",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const db = createAdminClient();

  // Cross-tenant guard: both projects, the resource member and the owner
  // (a profile) must belong to THIS workspace.
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "projects", id: parsed.data.project_a_id, field: "project_a_id" },
    { table: "projects", id: parsed.data.project_b_id, field: "project_b_id" },
    { table: "resource_members", id: parsed.data.resource_member_id, field: "resource_member_id" },
    { table: "profiles", id: parsed.data.owner_id, field: "owner_id" },
  ]);

  const refId = await nextRefId(db, actor.workspaceId, "clashes", "CL");

  const { data: row, error } = await db
    .from("clashes")
    .insert({
      ...parsed.data,
      workspace_id: actor.workspaceId,
      reference_id: refId,
    })
    .select()
    .single();

  if (error) throw error;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "clash.create",
    targetType: "clash",
    targetId: row.id,
    before: null,
    after: row,
  });

  return created(row);
});

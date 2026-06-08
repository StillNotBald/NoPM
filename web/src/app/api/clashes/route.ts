import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { ok, okList, created, safeJson, validationError } from "@/lib/api/response";
import { writeAudit } from "@/lib/audit/write";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClashSchema } from "./_schema";
import { nextRefId } from "@/lib/ref-id";

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

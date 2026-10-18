import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { okList, created, safeJson, validationError } from "@/lib/api/response";
import { auditedInsert } from "@/lib/audit/audited-write";
import { createAdminClient } from "@/lib/supabase/admin";
import { unknownFieldsResponse } from "@/lib/work/unknown-fields";
import { createResourceSchema } from "./_schema";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";

export const runtime = "nodejs";

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
    .from("resource_members")
    .select("*", { count: "exact", head: true })
    .eq("workspace_id", actor.workspaceId);

  const { data, error } = await db
    .from("resource_members")
    .select("*")
    .eq("workspace_id", actor.workspaceId)
    .order("name", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  return okList(data ?? [], { total: count ?? 0, page, limit });
});

export const POST = route(async ({ actor, request }) => {
  requireScope(actor, "resource:write");

  const body = await safeJson(request);
  const unknown = unknownFieldsResponse(body, createResourceSchema);
  if (unknown) return unknown;
  const parsed = createResourceSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid resource payload",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const db = createAdminClient();

  // Cross-tenant guard: the linked login (profile) must belong to THIS workspace.
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "profiles", id: parsed.data.profile_id, field: "profile_id" },
  ]);

  // Row and audit row are one transaction (nopm_mutate_audited, migration 0103).
  const row = await auditedInsert({
    table: "resource_members",
    actor,
    action: "resource.create",
    patch: { ...parsed.data },
  });

  return created(row);
});

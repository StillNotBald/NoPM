import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditedInsert } from "@/lib/audit/audited-write";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { unknownFieldsResponse } from "@/lib/work/unknown-fields";
import { createProgramSchema } from "./_schema";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";

export const runtime = "nodejs";

// GET /api/programs — list programs in the actor's workspace (program:read)
export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "program:read");

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10)));
  const offset = (page - 1) * limit;

  const db = createAdminClient();

  const { count, error: countError } = await db
    .from("programs")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", actor.workspaceId);

  if (countError) throw countError;

  const { data, error } = await db
    .from("programs")
    .select("*")
    .eq("workspace_id", actor.workspaceId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  return okList(data ?? [], { total: count ?? 0, page, limit });
});

// POST /api/programs — create a program (program:write)
export const POST = route(async ({ actor, request }) => {
  requireScope(actor, "program:write");

  const body = await safeJson(request);
  const unknown = unknownFieldsResponse(body, createProgramSchema);
  if (unknown) return unknown;
  const parsed = createProgramSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid program data",
      parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    );
  }

  const db = createAdminClient();

  // Cross-tenant guard: owner_id is a resource_member of THIS workspace.
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "resource_members", id: parsed.data.owner_id, field: "owner_id" },
  ]);

  const now = new Date().toISOString();
  // Row and audit row are one transaction (nopm_mutate_audited, migration 0103).
  const row = await auditedInsert({
    table: "programs",
    actor,
    action: "program.create",
    patch: { ...parsed.data, updated_at: now },
  });

  return created(row);
});

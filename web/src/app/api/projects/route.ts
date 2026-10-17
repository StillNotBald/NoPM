import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";
import { createProjectSchema } from "./_schema";

export const runtime = "nodejs";

// GET /api/projects — list projects in the actor's workspace (project:read)
// Filters: source, external_ref (complement seam, R-81 — both exact-match).
export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "project:read");

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10)));
  const offset = (page - 1) * limit;
  const source = searchParams.get("source");
  const externalRef = searchParams.get("external_ref");

  const db = createAdminClient();

  let countQuery = db
    .from("projects")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", actor.workspaceId);
  if (source) countQuery = countQuery.eq("source", source);
  if (externalRef) countQuery = countQuery.eq("external_ref", externalRef);

  const { count, error: countError } = await countQuery;

  if (countError) throw countError;

  let query = db
    .from("projects")
    .select("*")
    .eq("workspace_id", actor.workspaceId);
  if (source) query = query.eq("source", source);
  if (externalRef) query = query.eq("external_ref", externalRef);
  query = query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error } = await query;

  if (error) throw error;

  return okList(data ?? [], { total: count ?? 0, page, limit });
});

// POST /api/projects — create a project (project:write)
export const POST = route(async ({ actor, request }) => {
  requireScope(actor, "project:write");

  const body = await safeJson(request);
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid project data",
      parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    );
  }

  const db = createAdminClient();

  // owner_id must be a member of THIS workspace: a foreign id would push the
  // project's notifications (change requests, approvals) into another tenant.
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "profiles", id: parsed.data.owner_id, field: "owner_id" },
  ]);

  // A project is never BORN locked: locking snapshots the baselines and is
  // audited, and only POST /projects/:id/lock does that. Lock state is stripped
  // from the body (locked_at / locked_by were never in the schema), exactly as
  // PATCH does — otherwise `is_locked: true` here made a project frozen before
  // it had any baseline to freeze.
  const fields = { ...parsed.data };
  delete fields.is_locked;

  const now = new Date().toISOString();
  const { data: row, error } = await db
    .from("projects")
    .insert({
      ...fields,
      workspace_id: actor.workspaceId,
      updated_at: now,
    })
    .select()
    .single();

  if (error) throw error;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "project.create",
    targetType: "project",
    targetId: row.id,
    before: null,
    after: row,
  });

  return created(row);
});

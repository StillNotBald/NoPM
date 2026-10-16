import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { okList, created, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { principalOf } from "@/lib/governance/decide";
import { createRebaselineSchema } from "@/app/api/rebaselines/_schema";

export const runtime = "nodejs";

// GET /api/projects/[id]/rebaselines — list rebaselines for a project (project:read)
export const GET = route(async ({ actor, params, request }) => {
  requireScope(actor, "project:read");

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10)));
  const offset = (page - 1) * limit;

  const db = createAdminClient();

  // Verify project exists and belongs to workspace
  const { data: project, error: projectError } = await db
    .from("projects")
    .select("id")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (projectError) throw projectError;
  if (!project) throw new NotFoundError("Project not found");

  const { count, error: countError } = await db
    .from("rebaselines")
    .select("id", { count: "exact", head: true })
    .eq("project_id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (countError) throw countError;

  const { data, error } = await db
    .from("rebaselines")
    .select("*")
    .eq("project_id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .order("version", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  return okList(data ?? [], { total: count ?? 0, page, limit });
});

// POST /api/projects/[id]/rebaselines — create a rebaseline (project:write)
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "project:write");

  const db = createAdminClient();

  // Load project — need is_locked to determine initial status
  const { data: project, error: projectError } = await db
    .from("projects")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (projectError) throw projectError;
  if (!project) throw new NotFoundError("Project not found");

  const body = await safeJson(request);
  const parsed = createRebaselineSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    );
  }

  // Compute next version: max existing version for this project + 1
  const { data: maxRow, error: maxError } = await db
    .from("rebaselines")
    .select("version")
    .eq("project_id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (maxError) throw maxError;

  const nextVersion = (maxRow?.version ?? 0) + 1;

  // If project is locked → governed flow → pending_approval; else draft
  const status = project.is_locked ? "pending_approval" : "draft";

  const now = new Date().toISOString();

  const { data: row, error: insertError } = await db
    .from("rebaselines")
    .insert({
      workspace_id: actor.workspaceId,
      project_id: params.id,
      version: nextVersion,
      status,
      reason: parsed.data.reason,
      requested_by: actor.type === "user" ? actor.id : null,
      // The HUMAN behind the requester (the user, or the token's creator). The
      // legacy requested_by above is user-only, so a token-raised rebaseline
      // used to carry no requester at all and sign-off four-eyes had nothing
      // to compare against.
      requested_principal_id: principalOf(actor),
      before: (parsed.data.before ?? null) as object | null,
      after: (parsed.data.after ?? null) as object | null,
      created_at: now,
    })
    .select()
    .single();

  if (insertError) throw insertError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "rebaseline.create",
    targetType: "rebaseline",
    targetId: row.id,
    before: null,
    after: row,
  });

  return created(row);
});

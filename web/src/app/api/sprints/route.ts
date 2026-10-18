import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditedInsert } from "@/lib/audit/audited-write";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { createSprintSchema, SPRINT_STATES } from "./_schema";
import { unknownFieldsResponse } from "@/lib/work/unknown-fields";
import { withTimingFlag } from "@/lib/sprints/flags";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/sprints — list sprints in the actor's workspace (sprint:read).
// Filters: project_id, state. Ordered start_date desc.
export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "sprint:read");

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10) || 20));
  const offset = (page - 1) * limit;

  const projectId = searchParams.get("project_id");
  if (projectId && !UUID_RE.test(projectId)) {
    return validationError("Invalid project_id filter", [
      { field: "project_id", message: "must be a UUID" },
    ]);
  }

  const state = searchParams.get("state");
  if (state && !(SPRINT_STATES as readonly string[]).includes(state)) {
    return validationError("Invalid state filter", [
      { field: "state", message: `must be one of ${SPRINT_STATES.join(", ")}` },
    ]);
  }

  const db = createAdminClient();

  // Inlined filters (not a generic helper applied to the builder) — the
  // house TS2589 workaround used by every other register list route.
  let countQuery = db.from("sprints").select("id", { count: "exact", head: true }).eq("workspace_id", actor.workspaceId);
  if (projectId) countQuery = countQuery.eq("project_id", projectId);
  if (state) countQuery = countQuery.eq("state", state);
  const { count, error: countError } = await countQuery;
  if (countError) throw countError;

  let query = db
    .from("sprints")
    .select("*")
    .eq("workspace_id", actor.workspaceId)
    .order("start_date", { ascending: false })
    .range(offset, offset + limit - 1);
  if (projectId) query = query.eq("project_id", projectId);
  if (state) query = query.eq("state", state);

  const { data, error } = await query;
  if (error) throw error;

  // Q-WRK-4/5: computed timing_flag ("late_to_start" | "past_end" | null) — a
  // reminder only; NoPM never starts or closes a sprint by itself.
  return okList((data ?? []).map((s) => withTimingFlag(s)), { total: count ?? 0, page, limit });
});

// POST /api/sprints — create a sprint (sprint:write).
export const POST = route(async ({ actor, request }) => {
  requireScope(actor, "sprint:write");

  const body = await safeJson(request);
  const unknown = unknownFieldsResponse(body, createSprintSchema);
  if (unknown) return unknown;
  const parsed = createSprintSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid sprint data",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  if (parsed.data.end_date < parsed.data.start_date) {
    return validationError("Invalid sprint dates", [
      { field: "end_date", message: "end_date must be on or after start_date" },
    ]);
  }

  const db = createAdminClient();

  // Verify the project exists and belongs to this workspace.
  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("id", parsed.data.project_id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();
  if (!project) throw new NotFoundError("Project not found");

  const now = new Date().toISOString();
  // Row and audit row are one transaction (nopm_mutate_audited, migration 0103).
  const row = await auditedInsert({
    table: "sprints",
    actor,
    action: "sprint.create",
    patch: {
      project_id: parsed.data.project_id,
      name: parsed.data.name,
      goal: parsed.data.goal ?? null,
      start_date: parsed.data.start_date,
      end_date: parsed.data.end_date,
      state: "planned",
      updated_at: now,
    },
  });

  return created(row);
});

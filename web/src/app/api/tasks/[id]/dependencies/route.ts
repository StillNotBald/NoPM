import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { ok, created, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit/write";
import { z } from "zod";

export const runtime = "nodejs";

// ── Schemas ────────────────────────────────────────────────────────────────────

const DependencyType = z.enum(["FS", "SS", "FF", "SF"]);

const DependencyCreateSchema = z.object({
  predecessor_id: z.string().uuid("predecessor_id must be a UUID"),
  type: DependencyType.optional().default("FS"),
  lag_days: z.number().int().optional().default(0),
});

const DependencyDeleteSchema = z.object({
  predecessor_id: z.string().uuid("predecessor_id must be a UUID"),
});

type DependencyCreateInput = z.infer<typeof DependencyCreateSchema>;

// ── Circular-dependency guard (ported from prior-pmo-tool schedulerUtils) ──────────────

/**
 * Returns true if a path exists from `startId` to `endId` through
 * the existing task_dependencies graph (walking predecessor→successor).
 * Used to detect cycles before inserting a new edge.
 */
function hasPath(
  successorsMap: Map<string, string[]>,
  startId: string,
  endId: string,
  visited = new Set<string>(),
): boolean {
  if (startId === endId) return true;
  if (visited.has(startId)) return false;
  visited.add(startId);
  for (const next of successorsMap.get(startId) ?? []) {
    if (hasPath(successorsMap, next, endId, visited)) return true;
  }
  return false;
}

/**
 * Build the successors map (predecessor_id → successor_id[]) from all
 * task_dependencies rows that belong to the same project.
 */
async function buildSuccessorsMap(
  db: ReturnType<typeof createAdminClient>,
  projectId: string,
  workspaceId: string,
): Promise<Map<string, string[]>> {
  const { data: rows, error } = await db
    .from("task_dependencies")
    .select("predecessor_id, successor_id")
    .eq("workspace_id", workspaceId)
    .eq("project_id", projectId);

  if (error) throw new Error(error.message);

  const map = new Map<string, string[]>();
  for (const row of rows ?? []) {
    if (!map.has(row.predecessor_id)) map.set(row.predecessor_id, []);
    map.get(row.predecessor_id)!.push(row.successor_id);
  }
  return map;
}

// ── GET /api/tasks/[id]/dependencies — list deps for a task ──────────────────

export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "task:read");

  const db = createAdminClient();

  // Validate the task exists and belongs to this workspace
  const { data: task, error: taskErr } = await db
    .from("tasks")
    .select("id, project_id")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (taskErr) throw new Error(taskErr.message);
  if (!task) throw new NotFoundError("Task not found");

  const { data: deps, error } = await db
    .from("task_dependencies")
    .select("id, predecessor_id, successor_id, type, lag_days, created_at")
    .eq("workspace_id", actor.workspaceId)
    .or(`predecessor_id.eq.${params.id},successor_id.eq.${params.id}`)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);

  return ok(deps ?? []);
});

// ── POST /api/tasks/[id]/dependencies — add a dependency ─────────────────────

export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "task:write");

  const db = createAdminClient();

  // Validate the successor task exists and belongs to this workspace
  const { data: successorTask, error: taskErr } = await db
    .from("tasks")
    .select("id, project_id")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (taskErr) throw new Error(taskErr.message);
  if (!successorTask) throw new NotFoundError("Task not found");

  const body = await safeJson(request);
  const parsed = DependencyCreateSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const fields = parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    }));
    return validationError("Validation failed", fields);
  }

  const input: DependencyCreateInput = parsed.data;

  // A task cannot depend on itself
  if (input.predecessor_id === params.id) {
    throw new RuleError("A task cannot depend on itself", "self_dependency");
  }

  // Validate the predecessor task exists and belongs to the same workspace+project
  const { data: predecessorTask, error: predErr } = await db
    .from("tasks")
    .select("id, project_id")
    .eq("id", input.predecessor_id)
    .eq("workspace_id", actor.workspaceId)
    .eq("project_id", successorTask.project_id)
    .maybeSingle();

  if (predErr) throw new Error(predErr.message);
  if (!predecessorTask) {
    throw new NotFoundError("Predecessor task not found in this project");
  }

  // Check for duplicate
  const { data: existing } = await db
    .from("task_dependencies")
    .select("id")
    .eq("workspace_id", actor.workspaceId)
    .eq("predecessor_id", input.predecessor_id)
    .eq("successor_id", params.id)
    .maybeSingle();

  if (existing) {
    throw new RuleError(
      "This dependency already exists",
      "duplicate_dependency",
    );
  }

  // ── Circular-dependency guard ─────────────────────────────────────────────
  // Adding predecessor→successor creates a cycle if there is already a path
  // from successor back to predecessor (i.e., successor is an ancestor of predecessor).
  const successorsMap = await buildSuccessorsMap(
    db,
    successorTask.project_id,
    actor.workspaceId,
  );

  // Temporarily add the proposed edge to the map for the cycle check
  if (!successorsMap.has(input.predecessor_id))
    successorsMap.set(input.predecessor_id, []);
  successorsMap.get(input.predecessor_id)!.push(params.id);

  if (hasPath(successorsMap, params.id, input.predecessor_id)) {
    throw new RuleError(
      "Adding this dependency would create a circular reference",
      "circular_dependency",
    );
  }

  // ── Insert ────────────────────────────────────────────────────────────────
  const { data: dep, error: insertErr } = await db
    .from("task_dependencies")
    .insert({
      workspace_id: actor.workspaceId,
      project_id: successorTask.project_id,
      predecessor_id: input.predecessor_id,
      successor_id: params.id,
      type: input.type,
      lag_days: input.lag_days,
    })
    .select()
    .single();

  if (insertErr || !dep) throw new Error(insertErr?.message ?? "Insert failed");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "task_dependency.create",
    targetType: "task",
    targetId: params.id,
    before: null,
    after: dep,
  });

  return created(dep);
});

// ── DELETE /api/tasks/[id]/dependencies — remove a dependency ─────────────────

export const DELETE = route(async ({ actor, params, request }) => {
  requireScope(actor, "task:write");

  const db = createAdminClient();

  // Validate the task exists and belongs to this workspace
  const { data: task, error: taskErr } = await db
    .from("tasks")
    .select("id, project_id")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (taskErr) throw new Error(taskErr.message);
  if (!task) throw new NotFoundError("Task not found");

  const body = await safeJson(request);
  const parsed = DependencyDeleteSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const fields = parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    }));
    return validationError("Validation failed", fields);
  }

  const { predecessor_id } = parsed.data;

  const { data: dep, error: findErr } = await db
    .from("task_dependencies")
    .select("*")
    .eq("workspace_id", actor.workspaceId)
    .eq("predecessor_id", predecessor_id)
    .eq("successor_id", params.id)
    .maybeSingle();

  if (findErr) throw new Error(findErr.message);
  if (!dep) throw new NotFoundError("Dependency not found");

  const { error: delErr } = await db
    .from("task_dependencies")
    .delete()
    .eq("id", dep.id)
    .eq("workspace_id", actor.workspaceId);

  if (delErr) throw new Error(delErr.message);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "task_dependency.delete",
    targetType: "task",
    targetId: params.id,
    before: dep,
    after: null,
  });

  return new NextResponse(null, { status: 204 });
});

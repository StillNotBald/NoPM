import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { ok, created, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit/write";
import { assertProjectUnlocked } from "@/lib/governance/lock";
import { wouldCreateCycle, type DependencyEdge } from "@/lib/schedule/would-create-cycle";
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

// ── Edge loader for the circular-dependency guard ─────────────────────────────

/**
 * Load every task_dependencies edge of one project (workspace-scoped) so the
 * cycle check can run over them.
 */
async function loadProjectEdges(
  db: ReturnType<typeof createAdminClient>,
  projectId: string,
  workspaceId: string,
): Promise<DependencyEdge[]> {
  const { data: rows, error } = await db
    .from("task_dependencies")
    .select("predecessor_id, successor_id")
    .eq("workspace_id", workspaceId)
    .eq("project_id", projectId);

  if (error) throw new Error(error.message);
  return rows ?? [];
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

  // A new dependency edge reshapes the schedule graph — blocked while the
  // successor task's project is locked.
  await assertProjectUnlocked(db, successorTask.project_id, actor.workspaceId, () =>
    writeAudit({
      workspaceId: actor.workspaceId,
      actor,
      action: "dependency.create.blocked",
      targetType: "task",
      targetId: params.id,
      before: null,
      after: { reason: "project_locked", project_id: successorTask.project_id },
    }),
  );

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

  // Defensive: predecessor and successor are currently required to share a
  // project (see the query above), but guard the predecessor's project too
  // in case that constraint is ever relaxed.
  if (predecessorTask.project_id !== successorTask.project_id) {
    await assertProjectUnlocked(db, predecessorTask.project_id, actor.workspaceId, () =>
      writeAudit({
        workspaceId: actor.workspaceId,
        actor,
        action: "dependency.create.blocked",
        targetType: "task",
        targetId: params.id,
        before: null,
        after: { reason: "project_locked", project_id: predecessorTask.project_id },
      }),
    );
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
  // predecessor→successor closes a loop if the successor can already reach
  // the predecessor through existing edges.
  const edges = await loadProjectEdges(
    db,
    successorTask.project_id,
    actor.workspaceId,
  );

  if (wouldCreateCycle(edges, input.predecessor_id, params.id)) {
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

  // Removing a dependency edge reshapes the schedule graph — blocked while
  // the (successor) task's project is locked.
  await assertProjectUnlocked(db, task.project_id, actor.workspaceId, () =>
    writeAudit({
      workspaceId: actor.workspaceId,
      actor,
      action: "dependency.delete.blocked",
      targetType: "task",
      targetId: params.id,
      before: null,
      after: { reason: "project_locked", project_id: task.project_id },
    }),
  );

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

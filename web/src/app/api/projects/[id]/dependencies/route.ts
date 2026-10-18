import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { created, ok, safeJson, validationError } from "@/lib/api/response";
import { ConflictError, RuleError } from "@/lib/api/errors";
import { auditPrincipalId } from "@/lib/audit/write";
import { auditedInsert } from "@/lib/audit/audited-write";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";
import { wouldCreateProjectCycle } from "@/lib/insight/project-contingency";
import {
  createProjectDependencySchema,
  loadWorkspaceEdges,
  loadWorkspaceProject,
  type ProjectDependencyRow,
} from "./_shared";

export const runtime = "nodejs";

type NameRow = { id: string; code: string | null; name: string | null; rag_status: string | null };

/**
 * GET /api/projects/:id/dependencies - what this project depends on, and which
 * projects depend on it, each with the other project's code, name and declared RAG.
 */
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "project:read");
  const db = createAdminClient();
  await loadWorkspaceProject(db, actor.workspaceId, params.id);

  const [outRes, inRes] = await Promise.all([
    db.from("project_dependencies").select("*").eq("workspace_id", actor.workspaceId).eq("project_id", params.id),
    db
      .from("project_dependencies")
      .select("*")
      .eq("workspace_id", actor.workspaceId)
      .eq("depends_on_project_id", params.id),
  ]);
  if (outRes.error) throw new Error(outRes.error.message);
  if (inRes.error) throw new Error(inRes.error.message);
  const outgoing = (outRes.data ?? []) as ProjectDependencyRow[];
  const incoming = (inRes.data ?? []) as ProjectDependencyRow[];

  const otherIds = [
    ...new Set([...outgoing.map((d) => d.depends_on_project_id), ...incoming.map((d) => d.project_id)]),
  ];
  const names = new Map<string, NameRow>();
  if (otherIds.length > 0) {
    const { data, error } = await db
      .from("projects")
      .select("id, code, name, rag_status")
      .eq("workspace_id", actor.workspaceId)
      .in("id", otherIds);
    if (error) throw new Error(error.message);
    for (const p of (data ?? []) as NameRow[]) names.set(p.id, p);
  }

  const byCreated = (a: ProjectDependencyRow, b: ProjectDependencyRow) =>
    String(a.created_at).localeCompare(String(b.created_at));
  const other = (id: string) => {
    const p = names.get(id);
    return { id, code: p?.code ?? null, name: p?.name ?? null, rag_status: p?.rag_status ?? null };
  };
  const rows = [
    ...outgoing
      .sort(byCreated)
      .map((d) => ({ ...d, direction: "depends_on" as const, other_project: other(d.depends_on_project_id) })),
    ...incoming
      .sort(byCreated)
      .map((d) => ({ ...d, direction: "depended_on_by" as const, other_project: other(d.project_id) })),
  ];
  return ok(rows);
});

/**
 * POST /api/projects/:id/dependencies - declare that this project depends on another.
 *
 * A locked project may still gain (or lose) dependencies: a project dependency does
 * not change the locked schedule baseline (milestones, tasks, task edges), so this
 * route deliberately has no assertProjectUnlocked. Every change is still audited.
 */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "project:write");
  const db = createAdminClient();
  await loadWorkspaceProject(db, actor.workspaceId, params.id);

  const body = await safeJson(request);
  const parsed = createProjectDependencySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }
  const input = parsed.data;

  if (input.depends_on_project_id === params.id) {
    throw new RuleError("A project cannot depend on itself", "self_dependency");
  }

  // The other project (and the optional risk) must live in this workspace: 422, and the
  // same answer for "foreign" and "missing" so the route is not an existence oracle.
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "projects", id: input.depends_on_project_id, field: "depends_on_project_id" },
    { table: "risks", id: input.linked_risk_id ?? null, field: "linked_risk_id" },
  ]);

  // The risk explains the link, so it must belong to one of the two projects.
  if (input.linked_risk_id) {
    const { data: risk, error } = await db
      .from("risks")
      .select("id, project_id")
      .eq("id", input.linked_risk_id)
      .eq("workspace_id", actor.workspaceId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const rp = (risk as { project_id: string | null } | null)?.project_id;
    if (!rp || (rp !== params.id && rp !== input.depends_on_project_id)) {
      throw new RuleError("The linked risk must belong to one of the two projects", "risk_not_in_projects");
    }
  }

  const { data: dup, error: dupErr } = await db
    .from("project_dependencies")
    .select("id")
    .eq("workspace_id", actor.workspaceId)
    .eq("project_id", params.id)
    .eq("depends_on_project_id", input.depends_on_project_id)
    .eq("kind", input.kind)
    .maybeSingle();
  if (dupErr) throw new Error(dupErr.message);
  if (dup) throw new ConflictError("This dependency already exists", "duplicate_dependency");

  const edges = await loadWorkspaceEdges(db, actor.workspaceId);
  if (wouldCreateProjectCycle(edges, params.id, input.depends_on_project_id)) {
    throw new RuleError("Adding this dependency would create a circular reference", "circular_dependency");
  }

  // Row and audit row are one transaction (nopm_mutate_audited, migration 0103); the audit
  // row targets the project, as before.
  let dep;
  try {
    dep = await auditedInsert({
      table: "project_dependencies",
      actor,
      action: "project.dependency.add",
      targetType: "project",
      auditTargetId: params.id,
      patch: {
        project_id: params.id,
        depends_on_project_id: input.depends_on_project_id,
        kind: input.kind,
        linked_risk_id: input.linked_risk_id ?? null,
        note: input.note ?? null,
        created_by: auditPrincipalId(actor),
      },
    });
  } catch (insertErr) {
    // Database backstops (migration 0099) win a race the checks above lost.
    const msg = insertErr instanceof Error ? insertErr.message : String((insertErr as { message?: string })?.message ?? "Insert failed");
    if (msg.includes("DEPENDENCY_CYCLE")) {
      throw new RuleError("Adding this dependency would create a circular reference", "circular_dependency");
    }
    if (msg.includes("CROSS_WORKSPACE")) {
      throw new RuleError("Both projects must belong to this workspace", "cross_workspace");
    }
    if ((insertErr as { code?: string } | null)?.code === "23505") {
      throw new ConflictError("This dependency already exists", "duplicate_dependency");
    }
    throw insertErr instanceof Error ? insertErr : new Error(msg);
  }

  return created(dep);
});

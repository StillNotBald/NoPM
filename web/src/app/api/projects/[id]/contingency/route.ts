import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok } from "@/lib/api/response";
import { computeContingency } from "@/lib/insight/project-contingency";
import type { RagStatus } from "@/lib/status";
import { loadWorkspaceEdges, loadWorkspaceProject } from "../dependencies/_shared";

export const runtime = "nodejs";

/**
 * GET /api/projects/:id/contingency - the project's declared RAG, the worst declared
 * RAG among the projects it depends on (transitively, depth <= 5, cycle-safe) and
 * whether it is contingent on a red one, with the chain of projects that causes it.
 * Read-only and advisory: the declared RAG is returned as stored, never changed.
 */
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "project:read");
  const db = createAdminClient();
  await loadWorkspaceProject(db, actor.workspaceId, params.id);

  const [edges, projectsRes] = await Promise.all([
    loadWorkspaceEdges(db, actor.workspaceId),
    db.from("projects").select("id, code, name, rag_status").eq("workspace_id", actor.workspaceId),
  ]);
  if (projectsRes.error) throw new Error(projectsRes.error.message);
  const projects = (projectsRes.data ?? []) as {
    id: string;
    code: string | null;
    name: string | null;
    rag_status: string | null;
  }[];

  const ragById = new Map<string, RagStatus>();
  for (const p of projects) if (p.rag_status) ragById.set(p.id, p.rag_status as RagStatus);

  const result = computeContingency(params.id, ragById, edges);
  const byId = new Map(projects.map((p) => [p.id, p] as const));

  return ok({
    project_id: params.id,
    ...result,
    chain: result.chain.map((id) => ({
      id,
      code: byId.get(id)?.code ?? null,
      name: byId.get(id)?.name ?? null,
      rag_status: byId.get(id)?.rag_status ?? null,
    })),
  });
});

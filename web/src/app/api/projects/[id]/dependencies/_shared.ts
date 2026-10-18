import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { NotFoundError } from "@/lib/api/errors";

export const DEPENDENCY_KINDS = ["delivery", "resource", "decision", "risk"] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

export const createProjectDependencySchema = z.object({
  depends_on_project_id: z.string().uuid("depends_on_project_id must be a UUID"),
  kind: z.enum(DEPENDENCY_KINDS),
  linked_risk_id: z.string().uuid("linked_risk_id must be a UUID").nullable().optional(),
  note: z.string().trim().max(500, "note must be 500 characters or fewer").nullable().optional(),
});

export interface ProjectDependencyRow {
  id: string;
  workspace_id: string;
  project_id: string;
  depends_on_project_id: string;
  kind: DependencyKind;
  linked_risk_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** The project must exist in the caller's workspace, else 404 (same answer for "foreign" and "missing"). */
export async function loadWorkspaceProject(db: SupabaseClient, workspaceId: string, projectId: string) {
  const { data, error } = await db
    .from("projects")
    .select("id, code, name, rag_status")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFoundError("Project not found");
  return data as { id: string; code: string | null; name: string | null; rag_status: string | null };
}

/** Every dependency edge of the workspace (small: one row per declared link). */
export async function loadWorkspaceEdges(db: SupabaseClient, workspaceId: string) {
  const { data, error } = await db
    .from("project_dependencies")
    .select("project_id, depends_on_project_id")
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(error.message);
  return (data ?? []) as { project_id: string; depends_on_project_id: string }[];
}

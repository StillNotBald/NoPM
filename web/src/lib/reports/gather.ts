import { createAdminClient } from "@/lib/supabase/admin";

export type DeckProject = {
  code: string | null;
  name: string;
  program: string | null;
  rag_status: string;
  completion_pct: number;
};

export type PortfolioReport = {
  workspaceName: string;
  generatedAt: string;
  projects: DeckProject[];
  rag: Record<string, number>;
  registers: { risks: number; issues: number; clashes: number };
};

/** Build a portfolio report from the DB for a workspace (read-only). */
export async function gatherPortfolio(workspaceId: string): Promise<PortfolioReport> {
  const db = createAdminClient();
  const [ws, projects, risks, issues, clashes] = await Promise.all([
    db.from("workspaces").select("name").eq("id", workspaceId).maybeSingle(),
    db
      .from("projects")
      .select("code,name,program,rag_status,completion_pct")
      .eq("workspace_id", workspaceId)
      .order("created_at"),
    db.from("risks").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId),
    db.from("issues").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId),
    db.from("clashes").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId),
  ]);

  const rows = (projects.data ?? []) as DeckProject[];
  const rag: Record<string, number> = {};
  for (const p of rows) rag[p.rag_status] = (rag[p.rag_status] ?? 0) + 1;

  return {
    workspaceName: ws.data?.name ?? "Workspace",
    generatedAt: new Date().toISOString(),
    projects: rows,
    rag,
    registers: {
      risks: risks.count ?? 0,
      issues: issues.count ?? 0,
      clashes: clashes.count ?? 0,
    },
  };
}

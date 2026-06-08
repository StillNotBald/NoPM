import { createAdminClient } from "@/lib/supabase/admin";
import { computeEvm, type EvmResult } from "@/lib/evm";

// ─── shared types ────────────────────────────────────────────────────────────

export type DeckProject = {
  code: string | null;
  name: string;
  program: string | null;
  rag_status: string;
  completion_pct: number;
};

export type TopRisk = {
  title: string;
  severity: string;
  likelihood: string;
  status: string;
  project_name?: string;
};

export type TopIssue = {
  title: string;
  priority: string;
  status: string;
  project_name?: string;
};

export type MilestoneRow = {
  name: string;
  target_date: string | null;
  status: string;
  completion_pct: number;
  project_name?: string;
};

export type EvmTableRow = {
  project_name: string;
  bac: number;
  ev: number;
  ac: number;
  cv: number;
  cpi: number | null;
  spi: number | null;
  eac: number | null;
  vac: number | null;
};

// ─── portfolio report ─────────────────────────────────────────────────────────

export type PortfolioReport = {
  workspaceName: string;
  generatedAt: string;
  projects: DeckProject[];
  rag: Record<string, number>;
  registers: { risks: number; issues: number; clashes: number };
  evmTable: EvmTableRow[];
  topRisks: TopRisk[];
  topIssues: TopIssue[];
  milestones: MilestoneRow[];
};

/** Build a portfolio board pack from the DB for a workspace (read-only). */
export async function gatherPortfolio(workspaceId: string): Promise<PortfolioReport> {
  const db = createAdminClient();

  const [ws, projects, budgets, timeAgg, expenseAgg, risks, issues, clashes, milestones] =
    await Promise.all([
      db.from("workspaces").select("name").eq("id", workspaceId).maybeSingle(),
      db
        .from("projects")
        .select("id,code,name,program,rag_status,completion_pct")
        .eq("workspace_id", workspaceId)
        .order("created_at"),
      db
        .from("project_budget")
        .select("project_id,planned_amount,committed_amount")
        .eq("workspace_id", workspaceId),
      // Aggregate actual labour cost per project
      db
        .from("time_entries")
        .select("project_id,cost")
        .eq("workspace_id", workspaceId),
      // Aggregate expenses per project
      db
        .from("expenses")
        .select("project_id,amount")
        .eq("workspace_id", workspaceId),
      // Top 10 open/mitigating risks by severity
      db
        .from("risks")
        .select("title,severity,likelihood,status,project_id")
        .eq("workspace_id", workspaceId)
        .in("status", ["open", "mitigating"])
        .order("severity", { ascending: false })
        .limit(10),
      // Top 10 open issues by priority
      db
        .from("issues")
        .select("title,priority,status,project_id")
        .eq("workspace_id", workspaceId)
        .in("status", ["open", "in_progress"])
        .order("priority", { ascending: false })
        .limit(10),
      db.from("clashes").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId),
      // Upcoming / at-risk milestones
      db
        .from("milestones")
        .select("name,target_date,status,completion_pct,project_id")
        .eq("workspace_id", workspaceId)
        .in("status", ["not_started", "on_track", "at_risk", "delayed"])
        .order("target_date", { ascending: true })
        .limit(15),
    ]);

  const rows = (projects.data ?? []) as (DeckProject & { id: string })[];

  // project_id → name lookup
  const nameMap: Record<string, string> = {};
  for (const p of rows) nameMap[p.id] = p.name;

  // Aggregate AC per project
  const labourAc: Record<string, number> = {};
  for (const te of timeAgg.data ?? []) {
    labourAc[te.project_id] = (labourAc[te.project_id] ?? 0) + Number(te.cost);
  }
  const expenseAc: Record<string, number> = {};
  for (const ex of expenseAgg.data ?? []) {
    expenseAc[ex.project_id] = (expenseAc[ex.project_id] ?? 0) + Number(ex.amount);
  }

  // Build EVM table
  const budgetMap: Record<string, { planned_amount: number; committed_amount: number }> = {};
  for (const b of budgets.data ?? []) {
    budgetMap[b.project_id] = {
      planned_amount: Number(b.planned_amount),
      committed_amount: Number(b.committed_amount),
    };
  }

  const evmTable: EvmTableRow[] = rows.map((p) => {
    const budget = budgetMap[p.id] ?? { planned_amount: 0, committed_amount: 0 };
    const actual_amount = (labourAc[p.id] ?? 0) + (expenseAc[p.id] ?? 0);
    const evm: EvmResult = computeEvm({
      planned_amount: budget.planned_amount,
      committed_amount: budget.committed_amount,
      actual_amount,
      completion_pct: Number(p.completion_pct),
    });
    return {
      project_name: p.name,
      bac: evm.bac,
      ev: evm.ev,
      ac: evm.ac,
      cv: evm.cv,
      cpi: evm.cpi,
      spi: evm.spi,
      eac: evm.eac,
      vac: evm.vac,
    };
  });

  const rag: Record<string, number> = {};
  for (const p of rows) rag[p.rag_status] = (rag[p.rag_status] ?? 0) + 1;

  const topRisks: TopRisk[] = (risks.data ?? []).map((r) => ({
    title: r.title,
    severity: r.severity,
    likelihood: r.likelihood,
    status: r.status,
    project_name: nameMap[r.project_id],
  }));

  const topIssues: TopIssue[] = (issues.data ?? []).map((i) => ({
    title: i.title,
    priority: i.priority,
    status: i.status,
    project_name: nameMap[i.project_id],
  }));

  const milestonesOut: MilestoneRow[] = (milestones.data ?? []).map((m) => ({
    name: m.name,
    target_date: m.target_date,
    status: m.status,
    completion_pct: Number(m.completion_pct),
    project_name: nameMap[m.project_id],
  }));

  return {
    workspaceName: ws.data?.name ?? "Workspace",
    generatedAt: new Date().toISOString(),
    projects: rows,
    rag,
    registers: {
      risks: (risks.data ?? []).length, // approximate; full count below via separate q if needed
      issues: (issues.data ?? []).length,
      clashes: clashes.count ?? 0,
    },
    evmTable,
    topRisks,
    topIssues,
    milestones: milestonesOut,
  };
}

// ─── per-project report ───────────────────────────────────────────────────────

export type ProjectReport = {
  workspaceName: string;
  generatedAt: string;
  project: {
    id: string;
    code: string | null;
    name: string;
    program: string | null;
    description: string | null;
    rag_status: string;
    completion_pct: number;
    start_date: string | null;
    target_date: string | null;
    currency: string;
  };
  evm: EvmResult;
  registers: { risks: number; issues: number };
  topRisks: TopRisk[];
  topIssues: TopIssue[];
  milestones: MilestoneRow[];
};

/** Build a single-project status report from the DB (read-only). */
export async function gatherProject(
  workspaceId: string,
  projectId: string,
): Promise<ProjectReport | null> {
  const db = createAdminClient();

  const [ws, projectRes, budget, timeAgg, expenseAgg, risks, issues, milestones] =
    await Promise.all([
      db.from("workspaces").select("name").eq("id", workspaceId).maybeSingle(),
      db
        .from("projects")
        .select("id,code,name,program,description,rag_status,completion_pct,start_date,target_date,currency")
        .eq("id", projectId)
        .eq("workspace_id", workspaceId)
        .maybeSingle(),
      db
        .from("project_budget")
        .select("planned_amount,committed_amount")
        .eq("project_id", projectId)
        .eq("workspace_id", workspaceId)
        .maybeSingle(),
      db
        .from("time_entries")
        .select("cost")
        .eq("project_id", projectId)
        .eq("workspace_id", workspaceId),
      db
        .from("expenses")
        .select("amount")
        .eq("project_id", projectId)
        .eq("workspace_id", workspaceId),
      db
        .from("risks")
        .select("title,severity,likelihood,status")
        .eq("project_id", projectId)
        .eq("workspace_id", workspaceId)
        .in("status", ["open", "mitigating"])
        .order("severity", { ascending: false })
        .limit(10),
      db
        .from("issues")
        .select("title,priority,status")
        .eq("project_id", projectId)
        .eq("workspace_id", workspaceId)
        .in("status", ["open", "in_progress"])
        .order("priority", { ascending: false })
        .limit(10),
      db
        .from("milestones")
        .select("name,target_date,status,completion_pct")
        .eq("project_id", projectId)
        .eq("workspace_id", workspaceId)
        .order("target_date", { ascending: true })
        .limit(20),
    ]);

  if (!projectRes.data) return null;

  const p = projectRes.data;
  const planned_amount = Number(budget.data?.planned_amount ?? 0);
  const committed_amount = Number(budget.data?.committed_amount ?? 0);
  const labourAc = (timeAgg.data ?? []).reduce((s, t) => s + Number(t.cost), 0);
  const expenseAcSum = (expenseAgg.data ?? []).reduce((s, e) => s + Number(e.amount), 0);
  const actual_amount = labourAc + expenseAcSum;

  const evm = computeEvm({
    planned_amount,
    committed_amount,
    actual_amount,
    completion_pct: Number(p.completion_pct),
  });

  const topRisks: TopRisk[] = (risks.data ?? []).map((r) => ({
    title: r.title,
    severity: r.severity,
    likelihood: r.likelihood,
    status: r.status,
  }));

  const topIssues: TopIssue[] = (issues.data ?? []).map((i) => ({
    title: i.title,
    priority: i.priority,
    status: i.status,
  }));

  const milestonesOut: MilestoneRow[] = (milestones.data ?? []).map((m) => ({
    name: m.name,
    target_date: m.target_date,
    status: m.status,
    completion_pct: Number(m.completion_pct),
  }));

  return {
    workspaceName: ws.data?.name ?? "Workspace",
    generatedAt: new Date().toISOString(),
    project: {
      id: p.id,
      code: p.code,
      name: p.name,
      program: p.program,
      description: p.description,
      rag_status: p.rag_status,
      completion_pct: Number(p.completion_pct),
      start_date: p.start_date,
      target_date: p.target_date,
      currency: p.currency,
    },
    evm,
    registers: {
      risks: (risks.data ?? []).length,
      issues: (issues.data ?? []).length,
    },
    topRisks,
    topIssues,
    milestones: milestonesOut,
  };
}

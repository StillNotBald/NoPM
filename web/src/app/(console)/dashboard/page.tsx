import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { ragLabel, ragTone } from "@/lib/status";
import { cn } from "@/lib/cn";
import { RagDonutCard } from "@/components/dashboard/rag-donut-card";
import { ProgramBarCard } from "@/components/dashboard/program-bar-card";
import { HealthRollupCards } from "@/components/dashboard/health-rollup-cards";
import { ExportBoardPack } from "@/components/dashboard/export-board-pack";

// ── types ────────────────────────────────────────────────────────────────────

type RagStatus = "green" | "amber" | "red" | "not_started" | "complete";

interface Project {
  id: string;
  code: string;
  name: string;
  rag_status: RagStatus;
  completion_pct: number | null;
  program: string | null;
  target_date: string | null;
}

// ── page ─────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Parallel fetches
  const [projectsResult, risksResult, issuesResult, clashesResult] = await Promise.all([
    db.from("projects").select("id,code,name,rag_status,completion_pct,program,target_date"),
    db.from("risks").select("project_id,status"),
    db.from("issues").select("project_id,status"),
    db.from("clashes").select("id", { count: "exact", head: true }),
  ]);

  const projects: Project[] = (projectsResult.data ?? []) as Project[];
  const riskRows = (risksResult.data ?? []) as { project_id: string | null; status: string }[];
  const issueRows = (issuesResult.data ?? []) as { project_id: string | null; status: string }[];
  const riskCount = riskRows.length;
  const issueCount = issueRows.length;
  const clashCount = clashesResult.count ?? 0;

  // per-project OPEN counts — the iron-triangle health shown on each portfolio row
  const openRisksByProject = new Map<string, number>();
  for (const r of riskRows) {
    if (r.project_id && (r.status === "open" || r.status === "mitigating")) {
      openRisksByProject.set(r.project_id, (openRisksByProject.get(r.project_id) ?? 0) + 1);
    }
  }
  const openIssuesByProject = new Map<string, number>();
  for (const it of issueRows) {
    if (it.project_id && (it.status === "open" || it.status === "in_progress")) {
      openIssuesByProject.set(it.project_id, (openIssuesByProject.get(it.project_id) ?? 0) + 1);
    }
  }

  // ── RAG counts ──────────────────────────────────────────────────────────────
  const totalProjects = projects.length;
  const greenCount    = projects.filter((p) => p.rag_status === "green").length;
  const amberCount    = projects.filter((p) => p.rag_status === "amber").length;
  const redCount      = projects.filter((p) => p.rag_status === "red").length;
  const completeCount = projects.filter((p) => p.rag_status === "complete").length;
  const notStarted    = projects.filter((p) => p.rag_status === "not_started").length;

  // ── Overdue count — projects with target_date in the past and not complete ─
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const overdueCount = projects.filter((p) => {
    if (p.rag_status === "complete") return false;
    if (!p.target_date) return false;
    return new Date(p.target_date) < today;
  }).length;

  // ── Program breakdown ───────────────────────────────────────────────────────
  const programMap = new Map<string | null, number>();
  for (const p of projects) {
    const key = p.program ?? null;
    programMap.set(key, (programMap.get(key) ?? 0) + 1);
  }
  const programs = Array.from(programMap.entries()).map(([program, count]) => ({
    program,
    count,
  }));

  const ragCounts = { green: greenCount, amber: amberCount, red: redCount, complete: completeCount, not_started: notStarted };

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <PageHeader title="Command Centre" action={<ExportBoardPack />} />

      {/* ── Health rollup KPI strip ── */}
      <HealthRollupCards
        totalProjects={totalProjects}
        greenCount={greenCount}
        amberCount={amberCount}
        redCount={redCount}
        completeCount={completeCount}
        riskCount={riskCount}
        issueCount={issueCount}
        clashCount={clashCount}
        overdueCount={overdueCount}
      />

      {/* ── Charts row: RAG donut + program bar ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <RagDonutCard counts={ragCounts} />
        <ProgramBarCard programs={programs} />
      </div>

      {/* ── Portfolio table ── */}
      <Card>
        <CardHeader>
          <CardTitle>Portfolio</CardTitle>
          <span className="text-xs text-ink-muted">{totalProjects} projects</span>
        </CardHeader>
        <CardBody className="p-0">
          {projects.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-ink-muted">
              No projects yet. Create your first project to get started.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border-subtle">
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-widest text-ink-muted">
                      Code
                    </th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-widest text-ink-muted">
                      Name
                    </th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-widest text-ink-muted">
                      RAG
                    </th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-widest text-ink-muted">
                      Completion
                    </th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-widest text-ink-muted">
                      Risks
                    </th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-widest text-ink-muted">
                      Issues
                    </th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-widest text-ink-muted">
                      Program
                    </th>
                    <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-widest text-ink-muted">
                      Target
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((project, i) => {
                    const pct = Math.min(100, Math.max(0, project.completion_pct ?? 0));
                    const isOverdue =
                      project.rag_status !== "complete" &&
                      !!project.target_date &&
                      new Date(project.target_date) < today;
                    const openR = openRisksByProject.get(project.id) ?? 0;
                    const openI = openIssuesByProject.get(project.id) ?? 0;

                    return (
                      <tr
                        key={project.id}
                        className={cn(
                          "transition-colors duration-100 hover:bg-sunken",
                          i !== projects.length - 1 && "border-b border-border-subtle",
                        )}
                      >
                        {/* Code */}
                        <td className="px-5 py-3.5">
                          <span className="font-mono text-xs font-medium text-ink-secondary">
                            {project.code}
                          </span>
                        </td>

                        {/* Name */}
                        <td className="px-5 py-3.5">
                          <span className="font-medium text-ink">{project.name}</span>
                        </td>

                        {/* RAG Badge */}
                        <td className="px-5 py-3.5">
                          <Badge tone={ragTone(project.rag_status)}>
                            {ragLabel(project.rag_status)}
                          </Badge>
                        </td>

                        {/* Completion bar */}
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-3">
                            <div className="h-1.5 w-28 overflow-hidden rounded-full bg-sunken">
                              <div
                                className="h-full rounded-full bg-accent transition-all duration-300"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="w-8 text-right text-xs tabular-nums text-ink-secondary">
                              {pct}%
                            </span>
                          </div>
                        </td>

                        {/* Open risks */}
                        <td className="px-5 py-3.5">
                          {openR > 0 ? (
                            <span className="inline-flex min-w-[1.6rem] justify-center rounded-md bg-danger/10 px-1.5 py-0.5 text-xs font-medium tabular-nums text-danger">
                              {openR}
                            </span>
                          ) : (
                            <span className="text-ink-muted">—</span>
                          )}
                        </td>

                        {/* Open issues */}
                        <td className="px-5 py-3.5">
                          {openI > 0 ? (
                            <span className="inline-flex min-w-[1.6rem] justify-center rounded-md bg-warning/10 px-1.5 py-0.5 text-xs font-medium tabular-nums text-warning">
                              {openI}
                            </span>
                          ) : (
                            <span className="text-ink-muted">—</span>
                          )}
                        </td>

                        {/* Program */}
                        <td className="px-5 py-3.5 text-ink-secondary">
                          {project.program ?? (
                            <span className="text-ink-muted">—</span>
                          )}
                        </td>

                        {/* Target date */}
                        <td className="px-5 py-3.5">
                          {project.target_date ? (
                            <span
                              className={cn(
                                "font-mono text-xs tabular-nums",
                                isOverdue ? "text-danger font-medium" : "text-ink-secondary",
                              )}
                            >
                              {new Date(project.target_date).toLocaleDateString("en-GB", {
                                day: "2-digit",
                                month: "short",
                                year: "numeric",
                              })}
                              {isOverdue && (
                                <span className="ml-1.5 inline-block rounded-full bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">
                                  overdue
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-ink-muted">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { ragLabel, ragTone } from "@/lib/status";
import { cn } from "@/lib/cn";

// ── types ────────────────────────────────────────────────────────────────────

type RagStatus = "green" | "amber" | "red" | "not_started" | "complete";

interface Project {
  id: string;
  code: string;
  name: string;
  rag_status: RagStatus;
  completion_pct: number | null;
  program: string | null;
}

// ── helpers ──────────────────────────────────────────────────────────────────

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
    db.from("projects").select("*"),
    db.from("risks").select("id", { count: "exact", head: true }),
    db.from("issues").select("id", { count: "exact", head: true }),
    db.from("clashes").select("id", { count: "exact", head: true }),
  ]);

  const projects: Project[] = (projectsResult.data ?? []) as Project[];
  const riskCount = risksResult.count ?? 0;
  const issueCount = issuesResult.count ?? 0;
  const clashCount = clashesResult.count ?? 0;

  // Stat counts
  const totalProjects = projects.length;
  const greenCount = projects.filter((p) => p.rag_status === "green").length;
  const amberCount = projects.filter((p) => p.rag_status === "amber").length;
  const redCount = projects.filter((p) => p.rag_status === "red").length;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <PageHeader title="Command Centre" />

      {/* ── Stat row ── */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label="Total Projects" value={totalProjects} />
        <StatCard
          label="On track"
          value={greenCount}
          accent={<span className="inline-block h-2 w-2 rounded-full bg-success" />}
        />
        <StatCard
          label="At risk"
          value={amberCount}
          accent={<span className="inline-block h-2 w-2 rounded-full bg-warning" />}
        />
        <StatCard
          label="Delayed"
          value={redCount}
          accent={<span className="inline-block h-2 w-2 rounded-full bg-danger" />}
        />
      </div>

      {/* ── Registers strip ── */}
      <div className="flex flex-wrap items-center gap-1 rounded-md border border-border-subtle bg-surface px-4 py-3">
        <p className="mr-3 text-xs font-medium uppercase tracking-widest text-ink-muted">
          Registers
        </p>
        <RegisterPill label="Risks" count={riskCount} tone="warning" />
        <span className="mx-2 text-border-strong">·</span>
        <RegisterPill label="Issues" count={issueCount} tone="danger" />
        <span className="mx-2 text-border-strong">·</span>
        <RegisterPill label="Clashes" count={clashCount} tone="info" />
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
                      Program
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((project, i) => {
                    const pct = Math.min(100, Math.max(0, project.completion_pct ?? 0));
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

                        {/* Program */}
                        <td className="px-5 py-3.5 text-ink-secondary">
                          {project.program ?? (
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

// ── sub-components ────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: React.ReactNode;
}) {
  return (
    <Card>
      <CardBody className="p-5">
        <div className="flex items-center gap-2">
          {accent}
          <p className="text-xs font-medium uppercase tracking-widest text-ink-muted">{label}</p>
        </div>
        <p className="mt-3 font-mono text-3xl font-semibold tabular-nums tracking-tight text-ink">{value}</p>
      </CardBody>
    </Card>
  );
}

function RegisterPill({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "info" | "warning" | "danger" | "neutral";
}) {
  return (
    <span className="flex items-center gap-1.5 text-sm">
      <Badge tone={tone}>{count}</Badge>
      <span className="text-ink-secondary">{label}</span>
    </span>
  );
}

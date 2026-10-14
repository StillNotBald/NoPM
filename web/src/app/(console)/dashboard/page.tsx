import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { APPEARANCE_COOKIE_NAME, parseAppearancePrefs } from "@/lib/theme/appearance";
import { formatByPref } from "@/lib/format/dates";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { QueryError } from "@/components/ui/query-error";
import { Table, THead, TH, TD } from "@/components/ui/data-table";
import { computeProgramRollup } from "@/lib/insight/program-rollup";
import { ragLabel, ragTone } from "@/lib/status";
import { cn } from "@/lib/cn";
import { RagDonutCard } from "@/components/dashboard/rag-donut-card";
import { ProgramBarCard } from "@/components/dashboard/program-bar-card";
import { HealthRollupCards } from "@/components/dashboard/health-rollup-cards";
import { ExportBoardPack } from "@/components/dashboard/export-board-pack";
import { EntityLink } from "@/components/ui/entity-link";
import { DashboardProjectRow } from "@/components/dashboard/dashboard-project-row";
import { CardFreshness } from "@/components/dashboard/card-freshness";
import { DashboardFilterBar } from "@/components/dashboard/dashboard-filter-bar";
import { FirstRunWizard } from "@/components/onboarding/first-run-wizard";
import { GovernanceTour } from "@/components/onboarding/governance-tour";
import {
  filterDashboardProjects,
  dashboardFilterLabel,
  type DashboardFilters,
} from "@/lib/insight/dashboard-filter";

export const metadata = { title: "Dashboard" };

// ── types ────────────────────────────────────────────────────────────────────

type RagStatus = "green" | "amber" | "red" | "not_started" | "complete";

interface Project {
  id: string;
  code: string;
  name: string;
  rag_status: RagStatus;
  completion_pct: number | null;
  /** Resolved program label: programs.name via program_id, else legacy text. */
  program: string | null;
  program_id: string | null;
  target_date: string | null;
}

// ── page ─────────────────────────────────────────────────────────────────────

type SearchParams = { [key: string]: string | string[] | undefined };

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();

  const dateDisplayPref = parseAppearancePrefs(
    (await cookies()).get(APPEARANCE_COOKIE_NAME)?.value,
  ).dateDisplay;

  if (!user) {
    redirect("/login");
  }

  // L-15 — dashboard-wide filter, URL-encoded (program / project / date-range).
  const sp = await searchParams;
  const filters: DashboardFilters = {
    program: firstParam(sp.program),
    project: firstParam(sp.project),
    dateFrom: firstParam(sp.date_from),
    dateTo: firstParam(sp.date_to),
  };

  // Parallel fetches — unfiltered; the filter is applied in JS below so
  // every card's numbers derive from the same filtered project set.
  const [projectsResult, programsResult, risksResult, issuesResult, clashesResult, viewerProfileResult] = await Promise.all([
    db.from("projects").select("id,code,name,rag_status,completion_pct,program,program_id,target_date"),
    db.from("programs").select("id,name"),
    db.from("risks").select("project_id,status"),
    db.from("issues").select("project_id,status"),
    db.from("clashes").select("id,project_a_id,project_b_id"),
    // caller's own role — mirrors requireScope() in lib/auth/guard.ts + the
    // same lookup risks/page.tsx uses: only "viewer" is read-only. Gates the
    // first-run wizard below (L-45 — viewers never see it, per
    // recon-identity.md §5 verify-as-funnel-identity).
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
  ]);
  const canWrite = viewerProfileResult.data?.role !== "viewer";

  // L-34 — stamp the fetch time right after the queries resolve (not render
  // time); every card on this page shares this one fetch, so one timestamp
  // is honest for all of them.
  const fetchedAt = new Date().toISOString();

  const queryError = projectsResult.error ?? risksResult.error ?? issuesResult.error ?? clashesResult.error;
  if (queryError) {
    return <QueryError what="dashboard data" message={queryError.message} />;
  }

  // Program labels: programs.name via program_id first, legacy text fallback.
  const programNameById = new Map<string, string>(
    ((programsResult.data ?? []) as { id: string; name: string }[]).map((pr) => [pr.id, pr.name]),
  );
  const allProjects: Project[] = ((projectsResult.data ?? []) as Project[]).map((p) => ({
    ...p,
    program: (p.program_id ? programNameById.get(p.program_id) : undefined) ?? p.program ?? null,
  }));
  const allRiskRows = (risksResult.data ?? []) as { project_id: string | null; status: string }[];
  const allIssueRows = (issuesResult.data ?? []) as { project_id: string | null; status: string }[];
  const allClashRows = (clashesResult.data ?? []) as {
    id: string;
    project_a_id: string | null;
    project_b_id: string | null;
  }[];

  // ── Apply the active filter to the project set, then scope every other
  // register (risks/issues/clashes) to that same filtered set. ──────────────
  const projects = filterDashboardProjects(allProjects, filters);
  const filteredProjectIds = new Set(projects.map((p) => p.id));
  const isFiltered = projects.length !== allProjects.length;

  const riskRows = isFiltered
    ? allRiskRows.filter((r) => r.project_id !== null && filteredProjectIds.has(r.project_id))
    : allRiskRows;
  const issueRows = isFiltered
    ? allIssueRows.filter((i) => i.project_id !== null && filteredProjectIds.has(i.project_id))
    : allIssueRows;
  const clashRows = isFiltered
    ? allClashRows.filter(
        (c) =>
          (c.project_a_id !== null && filteredProjectIds.has(c.project_a_id)) ||
          (c.project_b_id !== null && filteredProjectIds.has(c.project_b_id)),
      )
    : allClashRows;

  const riskCount = riskRows.length;
  const issueCount = issueRows.length;
  const clashCount = clashRows.length;

  // Active-filter subtitle — the filtered project's code/name, not its raw id.
  const filteredProject = filters.project ? allProjects.find((p) => p.id === filters.project) : undefined;
  const filterLabel = dashboardFilterLabel(filters, {
    projectLabel: filteredProject ? `${filteredProject.code} — ${filteredProject.name}` : undefined,
  });

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

  // ── Program breakdown — program_id first (same rollup as /portfolio),
  // legacy text fallback, then "(No program)". ─────────────────────────────
  const programGroups = new Map<string | null, Project[]>();
  for (const p of projects) {
    const key = p.program_id ?? (p.program ? `legacy:${p.program}` : null);
    const list = programGroups.get(key) ?? [];
    list.push(p);
    programGroups.set(key, list);
  }
  const programs = Array.from(programGroups.entries()).map(([key, children]) => {
    const rollup = computeProgramRollup(
      children.map((c) => ({
        projectId: c.id,
        completionPct: c.completion_pct ?? 0,
        plannedAmount: 0,
        committedAmount: 0,
        actualAmount: 0,
        currency: "USD",
        allocatedHours: 0,
        capacityHours: 0,
      })),
    );
    return {
      program: key === null ? null : (children[0].program ?? "(Unnamed program)"),
      count: rollup.projectCount,
      completionPct: rollup.completionPct,
    };
  });

  const ragCounts = { green: greenCount, amber: amberCount, red: redCount, complete: completeCount, not_started: notStarted };

  // Filter-bar dropdown options are drawn from the FULL (unfiltered) set so
  // choosing one filter never hides the others.
  const programOptions = Array.from(
    new Set(allProjects.map((p) => p.program).filter((p): p is string => !!p)),
  ).sort();
  const projectOptions = [...allProjects]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((p) => ({ id: p.id, label: `${p.code} — ${p.name}` }));

  return (
    <PageContainer className="space-y-6">
      <PageHeader title="Dashboard" action={<ExportBoardPack />} />

      {/* ── Governance tour (L-50, R-77) — every role incl. viewers, only
          once the workspace has at least one project anywhere (the
          first-run wizard below owns the zero-project empty state; this
          owns the seeded/demo state). Deliberately keyed off the FULL
          unfiltered project set, not the dashboard's active filter, so
          narrowing the filter to an empty slice never hides this card. ── */}
      {allProjects.length > 0 && (
        <GovernanceTour firstProjectHref={`/projects/${allProjects[0].id}`} />
      )}

      {/* ── Dashboard-wide filter (L-15) ── */}
      <DashboardFilterBar programs={programOptions} projects={projectOptions} />

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
        filterLabel={filterLabel}
        fetchedAt={fetchedAt}
      />

      {/* ── Charts row: RAG donut + program bar ── */}
      <div className="grid gap-4 lg:grid-cols-[repeat(2,minmax(0,1fr))] [&>*]:min-w-0">
        <RagDonutCard counts={ragCounts} filterLabel={filterLabel} fetchedAt={fetchedAt} />
        <ProgramBarCard programs={programs} filterLabel={filterLabel} fetchedAt={fetchedAt} />
      </div>

      {/* ── Portfolio table ── */}
      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Portfolio</CardTitle>
            <span className="mt-0.5 block text-xs text-ink-muted truncate">
              {totalProjects} projects{filterLabel ? ` · ${filterLabel}` : ""}
            </span>
          </div>
          <CardFreshness fetchedAt={fetchedAt} className="shrink-0" />
        </CardHeader>
        <CardBody className="p-0">
          {projects.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-sm text-ink-muted">
                No projects yet. Create your first project to get started.
              </p>
              {/* L-45 — first-run wizard replaces the old L-49 static pointer
                  link; the connect-agent link now lives as the wizard's own
                  last step. Viewers never get the wizard (canWrite gate is
                  computed server-side above via the caller's role) — T3
                  (F2c-mini) restores the plain one-line pointer link for
                  them so the connect-agent path stays reachable even
                  without the wizard. Writers who dismissed/completed the
                  wizard on a prior visit get the equivalent fallback from
                  inside FirstRunWizard itself (it knows that state
                  client-side; the server here only knows role). */}
              {canWrite ? (
                <FirstRunWizard />
              ) : (
                <p className="mt-4 text-center text-xs text-ink-muted">
                  Or{" "}
                  <a href="/tokens#connect-agent" className="text-accent hover:underline">
                    connect an AI agent →
                  </a>
                </p>
              )}
            </div>
          ) : (
            <Table bare className="min-w-[640px]">
                <THead>
                  <tr>
                    <TH>Code</TH>
                    <TH>Name</TH>
                    <TH>RAG</TH>
                    <TH>Completion</TH>
                    <TH>Risks</TH>
                    <TH>Issues</TH>
                    <TH>Program</TH>
                    <TH>Target</TH>
                  </tr>
                </THead>
                <tbody>
                  {projects.map((project) => {
                    const pct = Math.min(100, Math.max(0, project.completion_pct ?? 0));
                    const isOverdue =
                      project.rag_status !== "complete" &&
                      !!project.target_date &&
                      new Date(project.target_date) < today;
                    const openR = openRisksByProject.get(project.id) ?? 0;
                    const openI = openIssuesByProject.get(project.id) ?? 0;
                    const targetDate = project.target_date
                      ? formatByPref(project.target_date, dateDisplayPref)
                      : null;

                    return (
                      <DashboardProjectRow
                        key={project.id}
                        project={project}
                        openR={openR}
                        openI={openI}
                      >

                        {/* Name */}
                        <TD className="min-w-0 max-w-[260px]">
                          <EntityLink kind="project" id={project.id} className="font-medium">
                            {project.name}
                          </EntityLink>
                        </TD>

                        {/* RAG Badge */}
                        <TD>
                          <Badge size="sm" tone={ragTone(project.rag_status)}>
                            {ragLabel(project.rag_status)}
                          </Badge>
                        </TD>

                        {/* Completion bar */}
                        <TD>
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
                        </TD>

                        {/* Open risks */}
                        <TD>
                          {openR > 0 ? (
                            <Badge size="sm" tone="danger" className="tabular-nums">{openR}</Badge>
                          ) : (
                            <span className="text-ink-muted">—</span>
                          )}
                        </TD>

                        {/* Open issues */}
                        <TD>
                          {openI > 0 ? (
                            <Badge size="sm" tone="warning" className="tabular-nums">{openI}</Badge>
                          ) : (
                            <span className="text-ink-muted">—</span>
                          )}
                        </TD>

                        {/* Program */}
                        <TD className="min-w-0 max-w-[140px] truncate text-ink-secondary">
                          {project.program ?? (
                            <span className="text-ink-muted">—</span>
                          )}
                        </TD>

                        {/* Target date */}
                        <TD className="whitespace-nowrap">
                          {targetDate ? (
                            <span
                              title={targetDate.title}
                              className={cn(
                                "font-mono text-xs tabular-nums",
                                isOverdue ? "text-danger-ink font-medium" : "text-ink-secondary",
                              )}
                            >
                              {targetDate.text}
                              {isOverdue && (
                                <Badge size="sm" tone="danger" className="ml-1.5">overdue</Badge>
                              )}
                            </span>
                          ) : (
                            <span className="text-ink-muted">—</span>
                          )}
                        </TD>
                      </DashboardProjectRow>
                    );
                  })}
                </tbody>
              </Table>
          )}
        </CardBody>
      </Card>
    </PageContainer>
  );
}

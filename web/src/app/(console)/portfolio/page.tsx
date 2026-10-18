import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { QueryError } from "@/components/ui/query-error";
import { KpiTile } from "@/components/ui/kpi-tile";
import { ExportBoardPack } from "@/components/dashboard/export-board-pack";
import { PortfolioFilterBar } from "./portfolio-filter-bar";
import {
  PortfolioRoadmap,
  type PortfolioProject,
  type PortfolioMilestone,
} from "@/components/portfolio/roadmap";
import { ProgramRollupCard } from "@/components/portfolio/program-rollup-card";
import { NewProgramButton } from "@/components/forms/new-program-button";
import type { Program as ProgramRow } from "@/components/forms/program-form";
import {
  computeProgramRollup,
  computeChildRag,
  computeContingentOn,
  type ProgramRollupChildInput,
} from "@/lib/insight/program-rollup";
import { isOpenRisk } from "@/lib/insight/open-status";

export const metadata = { title: "Portfolio" };

// ── Row shapes (server-fetched) ──────────────────────────────────────────────
// ProgramRow reuses the exact shape ProgramForm edits (id, code, name,
// description, owner_id, rag_status) — one type, no drift between the list
// query and the edit form it feeds.

interface ProjectRow extends PortfolioProject {
  program_id: string | null;
  /** Legacy free-text program label (deprecated, 0034) — fallback grouping key. */
  program: string | null;
  currency: string | null;
}

interface BudgetRow {
  project_id: string;
  planned_amount: number | null;
  committed_amount: number | null;
  currency: string | null;
}
interface ExpenseRow {
  project_id: string;
  amount: number | null;
}
interface AllocationRow {
  project_id: string | null;
  member_id: string;
  allocation_pct: number | null;
  hours: number | null;
}
interface MemberRow {
  id: string;
  capacity_hours_per_week: number | null;
}

// ── Grouping ──────────────────────────────────────────────────────────────

type Group = {
  key: string;
  kind: "program" | "legacy" | "ungrouped";
  program?: ProgramRow;
  label: string;
  projects: ProjectRow[];
};

type SearchParams = Record<string, string | string[] | undefined>;
const firstParam = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

interface RiskRow {
  project_id: string | null;
  severity: string | null;
  status: string | null;
}

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();

  if (!user) redirect("/login");

  const sp = await searchParams;
  const programFilter = firstParam(sp.program);
  const ragFilter = firstParam(sp.rag);

  // One parallel round. RLS scopes every select to the user's workspace;
  // rollup inputs are narrowed to the visible project ids in JS below.
  const [
    programsResult,
    projectsResult,
    milestonesResult,
    risksRes,
    budgetRes,
    expenseRes,
    allocRes,
    memberRes,
    depsRes,
  ] = await Promise.all([
    db
      .from("programs")
      .select("id,code,name,description,owner_id,rag_status")
      .order("name", { ascending: true }),
    db
      .from("projects")
      .select(
        "id,code,name,rag_status,completion_pct,start_date,target_date,program_id,program,currency",
      )
      .order("code", { ascending: true }),
    db
      .from("milestones")
      .select(
        "project_id,name,target_date,baseline_target_date,status,completion_pct",
      )
      .order("target_date", { ascending: true, nullsFirst: false }),
    db.from("risks").select("project_id,severity,status"),
    db.from("project_budget").select("project_id,planned_amount,committed_amount,currency"),
    db.from("expenses").select("project_id,amount"),
    db.from("allocations").select("project_id,member_id,allocation_pct,hours"),
    db.from("resource_members").select("id,capacity_hours_per_week"),
    db.from("project_dependencies").select("project_id,depends_on_project_id"),
  ]);

  const checks: Array<[string, { message: string } | null]> = [
    ["programs", programsResult.error],
    ["projects", projectsResult.error],
    ["milestones", milestonesResult.error],
    ["risks", risksRes.error],
    ["budgets", budgetRes.error],
    ["expenses", expenseRes.error],
    ["allocations", allocRes.error],
    ["resource members", memberRes.error],
    ["project dependencies", depsRes.error],
  ];
  const failed = checks.find(([, e]) => e);
  if (failed) return <QueryError what={failed[0]} message={failed[1]?.message} />;

  const programs: ProgramRow[] = (programsResult.data ?? []) as ProgramRow[];
  const rawProjects: ProjectRow[] = (projectsResult.data ?? []) as ProjectRow[];

  // R-147: a project that is not red/complete but (transitively) depends on a red one is
  // marked "contingent". Computed over EVERY project so a filter cannot hide the red one;
  // the declared rag_status is never changed.
  const contingentOn = computeContingentOn(
    rawProjects.map((p) => ({ id: p.id, ragStatus: p.rag_status })),
    (depsRes.data ?? []) as { project_id: string; depends_on_project_id: string }[],
  );
  const projectById = new Map(rawProjects.map((p) => [p.id, p] as const));
  const allProjects: ProjectRow[] = rawProjects.map((p) => {
    const c = contingentOn.get(p.id);
    const red = c ? projectById.get(c.projectId) : undefined;
    return { ...p, contingent_on: red ? { code: red.code, name: red.name } : null };
  });

  // Filters: program id (or "ungrouped") and health.
  const projects = allProjects.filter((p) => {
    if (ragFilter && p.rag_status !== ragFilter) return false;
    if (programFilter === "ungrouped") return !p.program_id && !(p.program && p.program.trim());
    if (programFilter && p.program_id !== programFilter) return false;
    return true;
  });
  const projectIdSet = new Set(projects.map((p) => p.id));
  const milestones: PortfolioMilestone[] = (
    (milestonesResult.data ?? []) as PortfolioMilestone[]
  ).filter((m) => projectIdSet.has(m.project_id));

  // L-03 rollup inputs: project-keyed lookups.
  const budgetByProject: Record<
    string,
    { planned: number; committed: number; currency: string }
  > = {};
  const actualByProject: Record<string, number> = {};
  const allocatedByProject: Record<string, number> = {};
  const capacityByProject: Record<string, number> = {};

  for (const b of (budgetRes.data ?? []) as BudgetRow[]) {
    if (!projectIdSet.has(b.project_id)) continue;
    budgetByProject[b.project_id] = {
      planned: b.planned_amount ?? 0,
      committed: b.committed_amount ?? 0,
      currency: b.currency ?? "USD",
    };
  }
  for (const e of (expenseRes.data ?? []) as ExpenseRow[]) {
    if (!projectIdSet.has(e.project_id)) continue;
    actualByProject[e.project_id] = (actualByProject[e.project_id] ?? 0) + (e.amount ?? 0);
  }

  // Allocated/capacity hours per project (mirrors memberUtilisation's
  // hour-derivation in lib/resource/utilisation.ts, at project grain).
  const capacityByMember: Record<string, number> = {};
  for (const m of (memberRes.data ?? []) as MemberRow[]) {
    capacityByMember[m.id] = m.capacity_hours_per_week ?? 0;
  }
  const seenMemberPerProject = new Set<string>();
  const pctByMember: Record<string, number> = {};
  for (const a of (allocRes.data ?? []) as AllocationRow[]) {
    if (!a.project_id || !projectIdSet.has(a.project_id)) continue;
    const memberCap = capacityByMember[a.member_id] ?? 0;
    const hours = a.hours != null ? a.hours : ((a.allocation_pct ?? 0) / 100) * memberCap;
    allocatedByProject[a.project_id] = (allocatedByProject[a.project_id] ?? 0) + hours;
    // Over-allocation signal: sum of allocation % per member across visible projects.
    const pct =
      a.allocation_pct != null ? a.allocation_pct : memberCap > 0 ? (hours / memberCap) * 100 : 0;
    pctByMember[a.member_id] = (pctByMember[a.member_id] ?? 0) + pct;

    const key = `${a.project_id}:${a.member_id}`;
    if (!seenMemberPerProject.has(key)) {
      seenMemberPerProject.add(key);
      capacityByProject[a.project_id] = (capacityByProject[a.project_id] ?? 0) + memberCap;
    }
  }
  const overAllocated = Object.values(pctByMember).filter((v) => v > 100).length;

  const openHighRisks = ((risksRes.data ?? []) as RiskRow[]).filter(
    (r) =>
      r.project_id &&
      projectIdSet.has(r.project_id) &&
      (r.severity === "high" || r.severity === "critical") &&
      isOpenRisk(r.status),
  ).length;

  function rollupInputFor(p: ProjectRow): ProgramRollupChildInput {
    const budget = budgetByProject[p.id];
    return {
      projectId: p.id,
      completionPct: p.completion_pct ?? 0,
      plannedAmount: budget?.planned ?? 0,
      committedAmount: budget?.committed ?? 0,
      actualAmount: actualByProject[p.id] ?? 0,
      currency: budget?.currency ?? p.currency ?? "USD",
      allocatedHours: allocatedByProject[p.id] ?? 0,
      capacityHours: capacityByProject[p.id] ?? 0,
    };
  }

  // ── Group projects: real program_id first, legacy text fallback, then ungrouped ──
  const byProgramId = new Map<string, Group>();
  const byLegacyText = new Map<string, Group>();
  const ungrouped: ProjectRow[] = [];

  for (const program of programs) {
    byProgramId.set(program.id, {
      key: program.id,
      kind: "program",
      program,
      label: program.name,
      projects: [],
    });
  }

  for (const p of projects) {
    if (p.program_id && byProgramId.has(p.program_id)) {
      byProgramId.get(p.program_id)!.projects.push(p);
    } else if (p.program && p.program.trim() !== "") {
      const key = `legacy:${p.program}`;
      if (!byLegacyText.has(key)) {
        byLegacyText.set(key, { key, kind: "legacy", label: p.program, projects: [] });
      }
      byLegacyText.get(key)!.projects.push(p);
    } else {
      ungrouped.push(p);
    }
  }

  const programGroups = [...byProgramId.values()]
    .filter((g) => !(programFilter || ragFilter) || g.projects.length > 0).sort((a, b) => a.label.localeCompare(b.label));
  const legacyGroups = [...byLegacyText.values()].sort((a, b) => a.label.localeCompare(b.label));
  const ungroupedGroup: Group | null =
    ungrouped.length > 0
      ? { key: "ungrouped", kind: "ungrouped", label: "Ungrouped", projects: ungrouped }
      : null;

  const allGroups: Group[] = [
    ...programGroups,
    ...legacyGroups,
    ...(ungroupedGroup ? [ungroupedGroup] : []),
  ];

  // One program definition for the whole page: the program groups actually
  // drawn below (real programs + legacy text labels, not the "Ungrouped"
  // bucket). It used to count only rows in `programs`, so a workspace with two
  // legacy program groups read "0 programs" above them.
  const programCount = programGroups.length + legacyGroups.length;
  const programCountLabel = `${programCount} program${programCount !== 1 ? "s" : ""}`;
  const isFiltered = Boolean(programFilter || ragFilter);

  // Every group's roadmap plots on the SAME time axis (earliest to latest date
  // across the visible projects), so groups line up when read down the page.
  const spanDates = [
    ...projects.flatMap((p) => [p.start_date, p.target_date]),
    ...milestones.flatMap((m) => [m.target_date, m.baseline_target_date]),
  ]
    .filter((d): d is string => !!d)
    .sort();
  const axisSpan = { from: spanDates[0] ?? null, to: spanDates[spanDates.length - 1] ?? null };

  const ragCount = { green: 0, complete: 0, amber: 0, red: 0 };
  for (const p of projects) {
    if (p.rag_status in ragCount) ragCount[p.rag_status as keyof typeof ragCount]++;
  }
  const total = computeProgramRollup(projects.map(rollupInputFor));

  function milestonesFor(group: Group): PortfolioMilestone[] {
    const ids = new Set(group.projects.map((p) => p.id));
    return milestones.filter((m) => ids.has(m.project_id));
  }

  return (
    <PageContainer width="wide" className="space-y-6">
      {/* The project/program count used to sit inline before the New Program
          button; at phone widths that squeezed "Portfolio Roadmap" down to
          "P…" (PageHeader's title is the only flexible side of the row). It
          now lives in secondaryActions: inline at sm+ (same spot as before),
          collapsed into the 44px overflow menu below sm so the title has
          room to breathe. */}
      <PageHeader
        title="Portfolio Roadmap"
        exports={<ExportBoardPack filtered={isFiltered} />}
        action={<NewProgramButton />}
        secondaryActions={[
          <span
            key="count"
            className="whitespace-nowrap font-mono text-xs text-ink-muted tabular-nums"
          >
            {projects.length} project{projects.length !== 1 ? "s" : ""}
            {programCount > 0 ? ` · ${programCountLabel}` : ""}
          </span>,
        ]}
      />

      <PortfolioFilterBar
        programs={[
          ...programs.map((p) => ({ value: p.id, label: p.name })),
          { value: "ungrouped", label: "Ungrouped" },
        ]}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiTile
          label="Projects"
          value={projects.length}
          sub={programCountLabel}
        />
        <KpiTile
          label="Health mix"
          value={`${ragCount.green + ragCount.complete} / ${ragCount.amber} / ${ragCount.red}`}
          sub="on track / at risk / delayed"
        />
        <KpiTile
          label="Budget variance"
          value={
            total.currency === null
              ? "—"
              : `${total.budgetVariance < 0 ? "-" : "+"}${Math.abs(total.budgetVariance).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
          }
          sub={
            total.currency === null
              ? "No budget"
              : `${total.currency} ${total.actualAmount.toLocaleString("en-US", { maximumFractionDigits: 0 })} actual of ${total.plannedAmount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
          }
        />
        <KpiTile
          label="Capacity"
          value={
            total.capacityHours === 0
              ? "—"
              : `${Math.round((total.allocatedHours / total.capacityHours) * 100)}%`
          }
          sub={
            overAllocated > 0
              ? `${overAllocated} over-allocated member${overAllocated !== 1 ? "s" : ""}`
              : "No over-allocation"
          }
        />
        <KpiTile label="Open high risks" value={openHighRisks} sub="high or critical, unresolved" />
      </div>

      {allGroups.length === 0 ? (
        <PortfolioRoadmap projects={[]} milestones={[]} filtered={isFiltered} />
      ) : (
        allGroups.map((group) => (
          <section
            key={group.key}
            id={group.kind === "program" ? group.program!.id : undefined}
            className="space-y-2"
          >
            {group.kind === "program" && group.program ? (
              <ProgramRollupCard
                program={group.program}
                computedRag={computeChildRag(group.projects.map((p) => p.rag_status))}
                rollup={computeProgramRollup(group.projects.map(rollupInputFor))}
              />
            ) : (
              <div className="flex items-center gap-2 px-1">
                <span className="text-sm font-semibold text-ink">{group.label}</span>
                <span className="text-xs text-ink-muted">
                  {group.projects.length} project{group.projects.length !== 1 ? "s" : ""}
                  {group.kind === "legacy" ? " · legacy program label" : ""}
                </span>
              </div>
            )}

            {group.projects.length > 0 && (
              <PortfolioRoadmap
                projects={group.projects}
                milestones={milestonesFor(group)}
                axisSpan={axisSpan}
              />
            )}
          </section>
        ))
      )}
    </PageContainer>
  );
}

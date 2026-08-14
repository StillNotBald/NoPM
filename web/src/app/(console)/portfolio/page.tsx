import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
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
  type ProgramRollupChildInput,
} from "@/lib/insight/program-rollup";

export const metadata = { title: "Portfolio Roadmap — NoPM" };

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
interface TimeEntryRow {
  project_id: string;
  cost: number | null;
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

export default async function PortfolioPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();

  if (!user) redirect("/login");

  // Parallel fetches — RLS automatically scopes to the user's workspace
  const [programsResult, projectsResult, milestonesResult] = await Promise.all([
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
  ]);

  const programs: ProgramRow[] = (programsResult.data ?? []) as ProgramRow[];
  const projects: ProjectRow[] = (projectsResult.data ?? []) as ProjectRow[];
  const milestones: PortfolioMilestone[] = (milestonesResult.data ?? []) as PortfolioMilestone[];

  const projectIds = projects.map((p) => p.id);

  // ── L-03 rollup inputs — batched, project-keyed lookups ───────────────────
  const budgetByProject: Record<
    string,
    { planned: number; committed: number; currency: string }
  > = {};
  const actualByProject: Record<string, number> = {};
  const allocatedByProject: Record<string, number> = {};
  const capacityByProject: Record<string, number> = {};

  if (projectIds.length > 0) {
    const [budgetRes, timeRes, expenseRes, allocRes] = await Promise.all([
      db
        .from("project_budget")
        .select("project_id,planned_amount,committed_amount,currency")
        .in("project_id", projectIds),
      db.from("time_entries").select("project_id,cost").in("project_id", projectIds),
      db.from("expenses").select("project_id,amount").in("project_id", projectIds),
      db
        .from("allocations")
        .select("project_id,member_id,allocation_pct,hours")
        .in("project_id", projectIds),
    ]);

    for (const b of (budgetRes.data ?? []) as BudgetRow[]) {
      budgetByProject[b.project_id] = {
        planned: b.planned_amount ?? 0,
        committed: b.committed_amount ?? 0,
        currency: b.currency ?? "USD",
      };
    }
    for (const t of (timeRes.data ?? []) as TimeEntryRow[]) {
      actualByProject[t.project_id] = (actualByProject[t.project_id] ?? 0) + (t.cost ?? 0);
    }
    for (const e of (expenseRes.data ?? []) as ExpenseRow[]) {
      actualByProject[e.project_id] = (actualByProject[e.project_id] ?? 0) + (e.amount ?? 0);
    }

    // Allocated/capacity hours per project (mirrors memberUtilisation's
    // hour-derivation in lib/resource/utilisation.ts, at project grain):
    //   - allocated hours: allocations.hours when set, else
    //     allocation_pct/100 * the member's capacity_hours_per_week.
    //   - capacity hours: Σ capacity_hours_per_week of the DISTINCT members
    //     allocated to the project (the denominator for "allocated vs capacity").
    const allocRows = (allocRes.data ?? []) as AllocationRow[];
    const memberIds = [...new Set(allocRows.map((a) => a.member_id))];
    const capacityByMember: Record<string, number> = {};
    if (memberIds.length > 0) {
      const { data: memberRows } = await db
        .from("resource_members")
        .select("id,capacity_hours_per_week")
        .in("id", memberIds);
      for (const m of (memberRows ?? []) as MemberRow[]) {
        capacityByMember[m.id] = m.capacity_hours_per_week ?? 0;
      }
    }

    const seenMemberPerProject = new Set<string>();
    for (const a of allocRows) {
      if (!a.project_id) continue;
      const memberCap = capacityByMember[a.member_id] ?? 0;
      const hours = a.hours != null ? a.hours : ((a.allocation_pct ?? 0) / 100) * memberCap;
      allocatedByProject[a.project_id] = (allocatedByProject[a.project_id] ?? 0) + hours;

      const key = `${a.project_id}:${a.member_id}`;
      if (!seenMemberPerProject.has(key)) {
        seenMemberPerProject.add(key);
        capacityByProject[a.project_id] = (capacityByProject[a.project_id] ?? 0) + memberCap;
      }
    }
  }

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

  const programGroups = [...byProgramId.values()].sort((a, b) => a.label.localeCompare(b.label));
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

  function milestonesFor(group: Group): PortfolioMilestone[] {
    const ids = new Set(group.projects.map((p) => p.id));
    return milestones.filter((m) => ids.has(m.project_id));
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <PageHeader
        title="Portfolio Roadmap"
        action={
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-ink-muted tabular-nums">
              {projects.length} project{projects.length !== 1 ? "s" : ""}
              {programs.length > 0
                ? ` · ${programs.length} program${programs.length !== 1 ? "s" : ""}`
                : ""}
            </span>
            <NewProgramButton />
          </div>
        }
      />

      {allGroups.length === 0 ? (
        <PortfolioRoadmap projects={[]} milestones={[]} />
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
              <PortfolioRoadmap projects={group.projects} milestones={milestonesFor(group)} />
            )}
          </section>
        ))
      )}
    </div>
  );
}

import { DOCUMENT_EVIDENCE_COLUMNS } from "@/lib/documents/columns";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Lock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { ProjectActions } from "@/components/tracking/project-actions";
import { ProjectTabs } from "@/components/tracking/project-tabs";
import { HandoverBadge } from "@/components/tracking/handover-badge";
import { ProjectDependenciesPanel } from "@/components/tracking/project-dependencies-panel";
import { CrumbLabel } from "@/lib/nav/crumb-label";
import { ragLabel, ragTone, type RagStatus } from "@/lib/status";
import { fetchTaskStatusAges } from "@/lib/insight/status-age";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  try {
    const { id } = await params;
    const db = await createClient();
    // Same RLS/workspace-scoped client + table as the page's own project query.
    const { data } = await db.from("projects").select("code, name").eq("id", id).maybeSingle();
    if (data?.name) return { title: data.code ? `${data.code} · ${data.name}` : data.name };
  } catch {
    // fall through to the generic title
  }
  return { title: "Project" };
}

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  // Parallel fetches
  const [
    { data: project, error: projectError },
    { data: milestones },
    { data: tasks },
    { data: risks },
    { data: issues },
    { data: charterDocs },
  ] = await Promise.all([
    db
      .from("projects")
      .select(
        "id, code, name, description, program, rag_status, completion_pct, start_date, target_date, currency, is_locked, lock_reason",
      )
      .eq("id", id)
      .single(),
    db
      .from("milestones")
      .select("id, project_id, name, target_date, baseline_target_date, status, completion_pct, owner_id, sort_order")
      .eq("project_id", id)
      .order("sort_order", { ascending: true }),
    db
      .from("tasks")
      // created_at (L-23 "since created" fallback) + estimate_hours (already
      // selected, L-33 variance basis) are both additive to this list.
      .select("id, project_id, milestone_id, name, description, status, status_type, priority, start_date, due_date, baseline_start_date, baseline_due_date, completion_pct, sort_order, assignee_id, checklist, acceptance_criteria, estimate_hours, story_points, labels, blocked_by, created_at, source, external_ref, external_url")
      .eq("project_id", id)
      .order("sort_order", { ascending: true }),
    db
      .from("risks")
      .select("id, project_id, title, description, severity, likelihood, risk_category, impact_area, impact_areas, mitigation, status, raised_at, due_date")
      .eq("project_id", id)
      .order("raised_at", { ascending: false }),
    db
      .from("issues")
      .select("id, project_id, title, description, priority, resolution, status, raised_at, due_date")
      .eq("project_id", id)
      .order("raised_at", { ascending: false }),
    db
      .from("documents")
      .select(`id, workspace_id, project_id, reference_id, folder, title, doc_type, status, version, summary, body, external_url, owner_id, created_at, ${DOCUMENT_EVIDENCE_COLUMNS}`)
      .eq("project_id", id)
      .eq("doc_type", "charter")
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  if (projectError || !project) notFound();

  // Who locked it (migration 0088). Read apart from the main select and fail-soft, so a
  // build that is live a moment before the migration still renders the page.
  let lockedByLabel: string | null = null;
  if (project.is_locked) {
    const { data: lockRow } = await db.from("projects").select("locked_by_label").eq("id", id).maybeSingle();
    lockedByLabel = (lockRow as { locked_by_label?: string | null } | null)?.locked_by_label ?? null;
  }

  const safeProject = {
    ...project,
    description:    project.description    ?? null,
    program:        project.program        ?? null,
    start_date:     project.start_date     ?? null,
    target_date:    project.target_date    ?? null,
    lock_reason:    project.lock_reason    ?? null,
    locked_by_label: lockedByLabel,
    currency:       project.currency       ?? "USD",
    completion_pct: project.completion_pct ?? 0,
  };

  // ── L-23 status-aging — ONE batched audit_log query for every task on
  // this board, derived from the LAST real status_type transition. Fetched
  // in parallel with the R-33 Gantt/CPM dependency-graph query below (both
  // need `taskRows`/`taskIds`, so neither can join the first Promise.all). ──
  const taskRows = tasks ?? [];
  const taskIds = taskRows.map((t) => t.id);

  // task_dependencies has no project_id column, so it can't be scoped with
  // `.eq("project_id", id)` — it must be scoped through the task ids
  // instead. Both consumers of `dependencies` (cpm.ts's calculateCriticalPath
  // and gantt.tsx's arrow-drawing) only ever use a dependency edge when
  // BOTH predecessor_id and successor_id resolve inside THIS project's task
  // set (gantt.tsx looks both up in `taskRowIndex`, built solely from this
  // project's `tasks`; cpm.ts's `validDeps` filter requires `taskSet.has()`
  // on both ends). Since a dependency can only match that requirement if its
  // successor_id is one of this project's task ids, filtering on
  // `successor_id IN taskIds` alone already returns every edge either
  // consumer could use — a cross-project edge (predecessor here, successor
  // elsewhere, or vice versa) is filtered out downstream either way, so no
  // `.or(...)` on predecessor_id is needed.
  const [statusAges, { data: dependencies }] = await Promise.all([
    fetchTaskStatusAges(
      db,
      taskRows.map((t) => ({ id: t.id, created_at: t.created_at })),
    ),
    taskIds.length === 0
      ? Promise.resolve({ data: [] as { id: string; predecessor_id: string; successor_id: string; type: string; lag_days: number }[] })
      : db
          .from("task_dependencies")
          .select("id, predecessor_id, successor_id, type, lag_days")
          .in("successor_id", taskIds),
  ]);

  // Tasks enriched with the two read-only insight fields — merged onto the
  // same row (not a parallel array) so every downstream consumer (Activity
  // table, Kanban board) sees them for free via the existing `tasks` prop.
  const tasksWithInsight = taskRows.map((t) => {
    const age = statusAges.get(t.id);
    return {
      ...t,
      status_age_days: age?.days ?? null,
      status_age_since: age?.since ?? null,
    };
  });

  return (
    <div className="mx-auto min-w-0 max-w-6xl space-y-8 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <CrumbLabel id={safeProject.id} label={safeProject.code ?? safeProject.name} />
      {/* Header. An `@container`: the right-hand inspector (task / risk detail)
          narrows this column to ~530px WITHOUT changing the viewport, and the
          old viewport breakpoints (`sm:`) then kept the side-by-side title row,
          crushing the title to nothing under the badges and actions. The
          header now lays out by its own width. */}
      <div className="@container">
        {/* Title row: stacks until the header is `@6xl` (72rem) wide, then sits
            side by side (wayfinding handled by the shell-level Breadcrumbs bar) */}
        <div className="flex flex-col gap-3 @6xl:flex-row @6xl:items-start @6xl:justify-between">
          <div className="flex items-start gap-3 min-w-0">
            {safeProject.code && (
              <span className="mt-1 font-mono text-xs text-ink-muted bg-well border border-border-subtle rounded px-2 py-0.5 shrink-0">
                {safeProject.code}
              </span>
            )}
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight text-ink leading-snug sm:text-xl">
                {safeProject.name}
              </h1>
              {safeProject.program && (
                <p className="mt-0.5 text-sm text-ink-secondary">{safeProject.program}</p>
              )}
            </div>
          </div>

          {/* Right: badges + actions */}
          <div className="flex items-center gap-2 flex-wrap @6xl:flex-nowrap @6xl:justify-end @6xl:shrink-0">
            <Badge tone={ragTone(safeProject.rag_status as RagStatus)}>
              {ragLabel(safeProject.rag_status as RagStatus)}
            </Badge>
            {safeProject.is_locked && (
              <Badge tone="warning" className="flex items-center gap-1">
                <Lock size={11} />
                {safeProject.locked_by_label ? `Locked by ${safeProject.locked_by_label}` : "Locked"}
              </Badge>
            )}
            <HandoverBadge projectId={safeProject.id} />
            <ProjectActions project={safeProject} />
          </div>
        </div>

        {/* Completion bar — full width on mobile, capped on larger screens */}
        <div className="mt-5 flex items-center gap-3">
          <div className="flex-1 sm:max-w-xs h-2 rounded-full bg-well overflow-hidden">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${Math.min(100, safeProject.completion_pct)}%` }}
            />
          </div>
          <span className="text-sm tabular-nums text-ink-secondary">
            {Math.round(safeProject.completion_pct)}% complete
          </span>
        </div>

        {/* Lock reason banner */}
        {safeProject.is_locked && safeProject.lock_reason && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-warning/10 border border-warning/25 px-4 py-3 text-sm text-warning-ink">
            <Lock size={14} className="mt-0.5 shrink-0" />
            <span>
              <span className="font-medium">Lock reason:</span> {safeProject.lock_reason}
            </span>
          </div>
        )}
      </div>

      {/* Tabs (client) */}
      <ProjectTabs
        project={safeProject}
        milestones={milestones ?? []}
        tasks={tasksWithInsight}
        risks={risks ?? []}
        issues={issues ?? []}
        dependencies={dependencies ?? []}
        charterDoc={charterDocs?.[0] ?? null}
      />
      <ProjectDependenciesPanel projectId={safeProject.id} />
    </div>
  );
}

import { notFound, redirect } from "next/navigation";
import { Lock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { ProjectActions } from "@/components/tracking/project-actions";
import { ProjectTabs } from "@/components/tracking/project-tabs";
import { ragLabel, ragTone, type RagStatus } from "@/lib/status";
import { fetchTaskStatusAges } from "@/lib/insight/status-age";

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
    { data: dependencies },
    { data: charterDocs },
    { data: timeEntryRows },
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
      .select("id, project_id, milestone_id, name, description, status, status_type, priority, start_date, due_date, baseline_start_date, baseline_due_date, completion_pct, sort_order, assignee_id, checklist, acceptance_criteria, estimate_hours, story_points, labels, blocked_by, created_at")
      .eq("project_id", id)
      .order("sort_order", { ascending: true }),
    db
      .from("risks")
      .select("id, project_id, title, description, severity, likelihood, category, mitigation, status, raised_at, due_date")
      .eq("project_id", id)
      .order("raised_at", { ascending: false }),
    db
      .from("issues")
      .select("id, project_id, title, description, priority, resolution, status, raised_at, due_date")
      .eq("project_id", id)
      .order("raised_at", { ascending: false }),
    db
      .from("task_dependencies")
      .select("id, predecessor_id, successor_id, type, lag_days"),
    db
      .from("documents")
      .select("id, workspace_id, project_id, reference_id, folder, title, doc_type, status, version, summary, body, external_url, owner_id, created_at")
      .eq("project_id", id)
      .eq("doc_type", "charter")
      .order("created_at", { ascending: false })
      .limit(1),
    // L-33 — actuals for the variance column, ONE batched query (per-task
    // sum computed below), not per-row.
    db.from("time_entries").select("task_id, hours").eq("project_id", id),
  ]);

  if (projectError || !project) notFound();

  const safeProject = {
    ...project,
    description:    project.description    ?? null,
    program:        project.program        ?? null,
    start_date:     project.start_date     ?? null,
    target_date:    project.target_date    ?? null,
    lock_reason:    project.lock_reason    ?? null,
    currency:       project.currency       ?? "USD",
    completion_pct: project.completion_pct ?? 0,
  };

  // ── L-23 status-aging — ONE batched audit_log query for every task on
  // this board, derived from the LAST real status_type transition. ──────────
  const taskRows = tasks ?? [];
  const statusAges = await fetchTaskStatusAges(
    db,
    taskRows.map((t) => ({ id: t.id, created_at: t.created_at })),
  );

  // ── L-33 estimate variance — actual hours per task, batched from the
  // time_entries fetch above (Σ hours per task_id). ─────────────────────────
  const actualHoursByTask = new Map<string, number>();
  for (const row of (timeEntryRows ?? []) as { task_id: string | null; hours: number }[]) {
    if (!row.task_id) continue;
    actualHoursByTask.set(row.task_id, (actualHoursByTask.get(row.task_id) ?? 0) + (row.hours ?? 0));
  }
  const actualHoursByTaskObj = Object.fromEntries(actualHoursByTask);

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
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 mx-auto max-w-6xl space-y-8">
      {/* Header */}
      <div>
        {/* Title row: stacks on mobile, side-by-side on sm+
            (wayfinding handled by the shell-level Breadcrumbs bar) */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3 min-w-0">
            {safeProject.code && (
              <span className="mt-1 font-mono text-xs text-ink-muted bg-sunken border border-border-subtle rounded px-2 py-0.5 shrink-0">
                {safeProject.code}
              </span>
            )}
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold text-ink leading-snug">
                {safeProject.name}
              </h1>
              {safeProject.program && (
                <p className="mt-0.5 text-sm text-ink-secondary">{safeProject.program}</p>
              )}
            </div>
          </div>

          {/* Right: badges + actions */}
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <Badge tone={ragTone(safeProject.rag_status as RagStatus)}>
              {ragLabel(safeProject.rag_status as RagStatus)}
            </Badge>
            {safeProject.is_locked && (
              <Badge tone="warning" className="flex items-center gap-1">
                <Lock size={11} />
                Locked
              </Badge>
            )}
            <ProjectActions project={safeProject} />
          </div>
        </div>

        {/* Completion bar — full width on mobile, capped on larger screens */}
        <div className="mt-5 flex items-center gap-3">
          <div className="flex-1 sm:max-w-xs h-2 rounded-full bg-sunken overflow-hidden">
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
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-warning/10 border border-warning/25 px-4 py-3 text-sm text-warning">
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
        actualHoursByTask={actualHoursByTaskObj}
      />
    </div>
  );
}

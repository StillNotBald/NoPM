import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { KanbanBoard } from "@/components/kanban/board";
import { cn } from "@/lib/cn";

type RagStatus = "not_started" | "red" | "amber" | "green" | "complete";
type MilestoneStatus = "not_started" | "on_track" | "at_risk" | "delayed" | "completed";

function ragTone(rag: RagStatus): "neutral" | "danger" | "warning" | "success" | "accent" {
  switch (rag) {
    case "green": return "success";
    case "amber": return "warning";
    case "red": return "danger";
    case "complete": return "accent";
    default: return "neutral";
  }
}

function ragLabel(rag: RagStatus): string {
  switch (rag) {
    case "not_started": return "Not started";
    case "red": return "Red";
    case "amber": return "Amber";
    case "green": return "Green";
    case "complete": return "Complete";
  }
}

function milestoneTone(status: MilestoneStatus): "neutral" | "success" | "warning" | "danger" | "accent" {
  switch (status) {
    case "on_track": return "success";
    case "at_risk": return "warning";
    case "delayed": return "danger";
    case "completed": return "accent";
    default: return "neutral";
  }
}

function milestoneLabel(status: MilestoneStatus): string {
  switch (status) {
    case "not_started": return "Not started";
    case "on_track": return "On track";
    case "at_risk": return "At risk";
    case "delayed": return "Delayed";
    case "completed": return "Completed";
  }
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

  // Fetch project
  const { data: project, error: projectError } = await db
    .from("projects")
    .select("id, code, name, description, rag_status, completion_pct, target_date, is_locked, lock_reason, program")
    .eq("id", id)
    .single();

  if (projectError || !project) notFound();

  // Fetch milestones
  const { data: milestones } = await db
    .from("milestones")
    .select("id, name, target_date, status, completion_pct")
    .eq("project_id", id)
    .order("sort_order", { ascending: true });

  // Fetch tasks (for KanbanBoard)
  const { data: tasks } = await db
    .from("tasks")
    .select("*")
    .eq("project_id", id)
    .order("sort_order", { ascending: true });

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      {/* ── Project header ── */}
      <div>
        {/* Breadcrumb */}
        <div className="mb-4 flex items-center gap-2 text-xs text-ink-muted">
          <a href="/projects" className="hover:text-ink transition-colors">Projects</a>
          <span>/</span>
          <span className="text-ink-secondary">{project.name}</span>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            {project.code && (
              <span className="mt-1 font-mono text-xs text-ink-muted bg-sunken border border-border-subtle rounded px-2 py-0.5 shrink-0">
                {project.code}
              </span>
            )}
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-ink leading-snug">{project.name}</h1>
              {project.description && (
                <p className="mt-1 text-sm text-ink-secondary">{project.description}</p>
              )}
            </div>
          </div>

          {/* Badges cluster */}
          <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
            <Badge tone={ragTone(project.rag_status as RagStatus)}>
              {ragLabel(project.rag_status as RagStatus)}
            </Badge>
            {project.is_locked && (
              <Badge tone="warning">Locked</Badge>
            )}
          </div>
        </div>

        {/* Meta row */}
        <div className="mt-4 flex items-center gap-6 text-sm text-ink-secondary flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-ink-muted">Completion</span>
            <div className="flex items-center gap-2">
              <div className="w-24 h-1.5 rounded-full bg-sunken overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${project.completion_pct ?? 0}%` }}
                />
              </div>
              <span className="tabular-nums text-xs">{Math.round(project.completion_pct ?? 0)}%</span>
            </div>
          </div>
          {project.target_date && (
            <div className="flex items-center gap-1.5">
              <span className="text-ink-muted">Target</span>
              <span>
                {new Date(project.target_date).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </span>
            </div>
          )}
          {project.program && (
            <div className="flex items-center gap-1.5">
              <span className="text-ink-muted">Program</span>
              <span>{project.program}</span>
            </div>
          )}
        </div>

        {/* Lock reason */}
        {project.is_locked && project.lock_reason && (
          <div className="mt-3 px-3 py-2 rounded-md bg-warning/10 border border-warning/25 text-sm text-warning">
            <span className="font-medium">Lock reason:</span> {project.lock_reason}
          </div>
        )}
      </div>

      {/* ── Milestones ── */}
      {milestones && milestones.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Milestones</CardTitle>
            <span className="text-xs text-ink-muted">{milestones.length} total</span>
          </CardHeader>
          <div className="divide-y divide-border-subtle">
            {milestones.map((ms) => (
              <div key={ms.id} className="flex items-center justify-between px-5 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm text-ink font-medium truncate">{ms.name}</span>
                  <Badge tone={milestoneTone(ms.status as MilestoneStatus)}>
                    {milestoneLabel(ms.status as MilestoneStatus)}
                  </Badge>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  {typeof ms.completion_pct === "number" && (
                    <div className="flex items-center gap-1.5">
                      <div className="w-16 h-1.5 rounded-full bg-sunken overflow-hidden">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${ms.completion_pct}%` }}
                        />
                      </div>
                      <span className="text-xs text-ink-muted tabular-nums w-7 text-right">
                        {Math.round(ms.completion_pct)}%
                      </span>
                    </div>
                  )}
                  {ms.target_date ? (
                    <span className="text-xs text-ink-secondary tabular-nums">
                      {new Date(ms.target_date).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                  ) : (
                    <span className="text-xs text-ink-muted w-24 text-right">No date</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Kanban board ── */}
      <div>
        <h2 className="mb-4 text-base font-semibold text-ink">Tasks</h2>
        <KanbanBoard
          projectId={id}
          isLocked={project.is_locked}
          tasks={tasks ?? []}
        />
      </div>
    </div>
  );
}

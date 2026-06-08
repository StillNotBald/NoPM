"use client";

import { useMemo } from "react";
import { Diamond, Calendar } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

// ── Data shapes ───────────────────────────────────────────────────────────────

export interface Milestone {
  id: string;
  project_id: string;
  name: string;
  target_date: string | null;
  status: "not_started" | "on_track" | "at_risk" | "delayed" | "completed";
  completion_pct: number;
  owner_id: string | null;
  sort_order: number;
}

export interface Task {
  id: string;
  project_id: string;
  milestone_id: string | null;
  name: string;
  description: string | null;
  status: string;
  status_type: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  priority: "low" | "medium" | "high" | "urgent";
  start_date: string | null;
  due_date: string | null;
  completion_pct: number;
  sort_order: number;
  assignee_id: string | null;
}

interface GanttChartProps {
  projectId: string;
  milestones: Milestone[];
  tasks: Task[];
  isLocked: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

function milestoneStatusInfo(status: Milestone["status"]): {
  tone: BadgeTone;
  label: string;
} {
  switch (status) {
    case "completed": return { tone: "success", label: "Done" };
    case "on_track":  return { tone: "accent",  label: "On track" };
    case "at_risk":   return { tone: "warning", label: "At risk" };
    case "delayed":   return { tone: "danger",  label: "Delayed" };
    default:          return { tone: "neutral", label: "Not started" };
  }
}

function taskStatusInfo(st: Task["status_type"]): { tone: BadgeTone; label: string } {
  switch (st) {
    case "completed": return { tone: "success", label: "Done" };
    case "started":   return { tone: "accent",  label: "Active" };
    case "canceled":  return { tone: "neutral", label: "Canceled" };
    case "backlog":   return { tone: "neutral", label: "Backlog" };
    default:          return { tone: "neutral", label: "To do" };
  }
}

function barColor(status_type: Task["status_type"]): string {
  switch (status_type) {
    case "completed": return "bg-success";
    case "started":   return "bg-accent";
    case "canceled":  return "bg-ink-muted";
    default:          return "bg-border-subtle";
  }
}

function msBarColor(status: Milestone["status"]): string {
  switch (status) {
    case "completed": return "bg-success";
    case "on_track":  return "bg-accent";
    case "at_risk":   return "bg-warning";
    case "delayed":   return "bg-danger";
    default:          return "bg-border-subtle";
  }
}

// ── Date utilities ────────────────────────────────────────────────────────────

function toDay(d: string): number {
  return Math.floor(new Date(d).getTime() / 86_400_000);
}

function fmtShort(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function monthLabel(day: number): string {
  return new Date(day * 86_400_000).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
  });
}

// ── GanttChart ─────────────────────────────────────────────────────────────────

const COL_W = 28; // px per day column

export function GanttChart({ milestones, tasks, isLocked }: GanttChartProps) {
  // Gather all dates to compute timeline bounds
  const dates = [
    ...milestones.flatMap((m) => [m.target_date]),
    ...tasks.flatMap((t) => [t.start_date, t.due_date]),
  ].filter(Boolean) as string[];

  const { minDay, maxDay, totalDays, monthMarkers } = useMemo(() => {
    if (dates.length === 0) {
      const today = toDay(new Date().toISOString());
      return { minDay: today - 7, maxDay: today + 60, totalDays: 67, monthMarkers: [] as { label: string; col: number }[] };
    }
    const days = dates.map(toDay);
    const raw_min = Math.min(...days);
    const raw_max = Math.max(...days);
    const minDay = raw_min - 7;
    const maxDay = raw_max + 14;
    const totalDays = maxDay - minDay + 1;

    // Month boundary markers
    const markers: { label: string; col: number }[] = [];
    let cur = minDay;
    let prevMonth = -1;
    while (cur <= maxDay) {
      const d = new Date(cur * 86_400_000);
      const month = d.getMonth();
      if (month !== prevMonth) {
        markers.push({ label: monthLabel(cur), col: cur - minDay });
        prevMonth = month;
      }
      cur++;
    }

    return { minDay, maxDay, totalDays, monthMarkers: markers };
  }, [dates.join(",")]);

  const sortedMilestones = [...milestones].sort((a, b) => a.sort_order - b.sort_order);

  const totalWidth = totalDays * COL_W;

  // Today marker
  const todayCol = toDay(new Date().toISOString()) - minDay;

  function barProps(start: string | null, end: string | null) {
    const s = start ? toDay(start) - minDay : null;
    const e = end ? toDay(end) - minDay : null;
    if (s === null && e === null) return null;
    const left = (s ?? e!) * COL_W;
    const right = (e ?? s!) * COL_W + COL_W;
    return { left, width: Math.max(right - left, COL_W) };
  }

  if (milestones.length === 0 && tasks.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-border-subtle bg-surface py-16 text-center">
        <Calendar size={32} className="text-ink-muted opacity-40" />
        <p className="text-sm text-ink-secondary">No milestones or tasks to display.</p>
      </div>
    );
  }

  return (
    <section className="space-y-3">
      {isLocked && (
        <div className="flex items-center gap-2">
          <Badge tone="warning">Timeline locked — read only</Badge>
        </div>
      )}

      {/* Scrollable Gantt */}
      <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface">
        <div className="flex min-w-max">
          {/* Left label column (sticky) */}
          <div className="sticky left-0 z-10 bg-surface border-r border-border-subtle">
            {/* Header spacer */}
            <div className="h-10 border-b border-border-subtle px-4 flex items-center">
              <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">Name</span>
            </div>
            {/* Milestone + task rows */}
            {sortedMilestones.map((ms) => {
              const msTasks = tasks
                .filter((t) => t.milestone_id === ms.id)
                .sort((a, b) => a.sort_order - b.sort_order);
              return (
                <div key={ms.id}>
                  {/* Milestone label */}
                  <div className="flex items-center gap-2 border-b border-border-subtle px-4 h-10">
                    <Diamond size={12} className="shrink-0 text-accent" />
                    <span className="text-sm font-medium text-ink truncate max-w-[200px]">{ms.name}</span>
                    <Badge tone={milestoneStatusInfo(ms.status).tone} className="ml-auto shrink-0">
                      {milestoneStatusInfo(ms.status).label}
                    </Badge>
                  </div>
                  {/* Task labels */}
                  {msTasks.map((t) => (
                    <div key={t.id} className="flex items-center gap-2 border-b border-border-subtle px-4 h-9 pl-8">
                      <span className="text-xs text-ink-secondary truncate max-w-[200px]">{t.name}</span>
                      <Badge tone={taskStatusInfo(t.status_type).tone} className="ml-auto shrink-0 text-[10px]">
                        {taskStatusInfo(t.status_type).label}
                      </Badge>
                    </div>
                  ))}
                </div>
              );
            })}
            {/* Standalone tasks */}
            {tasks
              .filter((t) => !t.milestone_id)
              .sort((a, b) => a.sort_order - b.sort_order)
              .map((t) => (
                <div key={t.id} className="flex items-center gap-2 border-b border-border-subtle px-4 h-9">
                  <span className="text-xs text-ink-secondary truncate max-w-[200px]">{t.name}</span>
                  <Badge tone={taskStatusInfo(t.status_type).tone} className="ml-auto shrink-0 text-[10px]">
                    {taskStatusInfo(t.status_type).label}
                  </Badge>
                </div>
              ))}
          </div>

          {/* Right timeline area */}
          <div className="relative" style={{ width: totalWidth }}>
            {/* Month header */}
            <div
              className="relative h-10 border-b border-border-subtle bg-sunken/50"
              style={{ width: totalWidth }}
            >
              {monthMarkers.map((m) => (
                <div
                  key={`${m.label}-${m.col}`}
                  className="absolute top-0 h-full flex items-center px-2"
                  style={{ left: m.col * COL_W }}
                >
                  <span className="text-xs font-medium text-ink-muted whitespace-nowrap">{m.label}</span>
                  <div className="absolute left-0 top-0 h-full w-px bg-border-subtle" />
                </div>
              ))}
              {/* Today line header */}
              {todayCol >= 0 && todayCol <= totalDays && (
                <div
                  className="absolute top-0 h-full w-px bg-accent/50"
                  style={{ left: todayCol * COL_W }}
                />
              )}
            </div>

            {/* Rows */}
            {sortedMilestones.map((ms) => {
              const msTasks = tasks
                .filter((t) => t.milestone_id === ms.id)
                .sort((a, b) => a.sort_order - b.sort_order);

              const msBp = ms.target_date
                ? { left: (toDay(ms.target_date) - minDay) * COL_W, width: COL_W * 2 }
                : null;

              return (
                <div key={ms.id}>
                  {/* Milestone bar row */}
                  <div className="relative h-10 border-b border-border-subtle" style={{ width: totalWidth }}>
                    {todayCol >= 0 && todayCol <= totalDays && (
                      <div
                        className="absolute top-0 h-full w-px bg-accent/20"
                        style={{ left: todayCol * COL_W }}
                      />
                    )}
                    {msBp && (
                      <div
                        className={cn(
                          "absolute top-1/2 -translate-y-1/2 h-5 rounded flex items-center px-2",
                          msBarColor(ms.status),
                          "opacity-90"
                        )}
                        style={{ left: msBp.left, width: msBp.width }}
                        title={`Target: ${fmtShort(ms.target_date)}`}
                      >
                        <Diamond size={10} className="text-white shrink-0" />
                      </div>
                    )}
                  </div>
                  {/* Task bar rows */}
                  {msTasks.map((t) => {
                    const bp = barProps(t.start_date, t.due_date);
                    return (
                      <div
                        key={t.id}
                        className="relative h-9 border-b border-border-subtle"
                        style={{ width: totalWidth }}
                      >
                        {todayCol >= 0 && todayCol <= totalDays && (
                          <div
                            className="absolute top-0 h-full w-px bg-accent/20"
                            style={{ left: todayCol * COL_W }}
                          />
                        )}
                        {bp && (
                          <div
                            className={cn(
                              "absolute top-1/2 -translate-y-1/2 h-4 rounded-full",
                              barColor(t.status_type),
                              "opacity-80"
                            )}
                            style={{ left: bp.left, width: bp.width }}
                            title={`${fmtShort(t.start_date)} – ${fmtShort(t.due_date)}`}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {/* Standalone task rows */}
            {tasks
              .filter((t) => !t.milestone_id)
              .sort((a, b) => a.sort_order - b.sort_order)
              .map((t) => {
                const bp = barProps(t.start_date, t.due_date);
                return (
                  <div
                    key={t.id}
                    className="relative h-9 border-b border-border-subtle"
                    style={{ width: totalWidth }}
                  >
                    {todayCol >= 0 && todayCol <= totalDays && (
                      <div
                        className="absolute top-0 h-full w-px bg-accent/20"
                        style={{ left: todayCol * COL_W }}
                      />
                    )}
                    {bp && (
                      <div
                        className={cn(
                          "absolute top-1/2 -translate-y-1/2 h-4 rounded-full",
                          barColor(t.status_type),
                          "opacity-80"
                        )}
                        style={{ left: bp.left, width: bp.width }}
                        title={`${fmtShort(t.start_date)} – ${fmtShort(t.due_date)}`}
                      />
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      </div>

      <p className="text-xs text-ink-muted">
        Blue vertical line = today. Bars span task start → due dates; diamonds mark milestone targets.
      </p>
    </section>
  );
}

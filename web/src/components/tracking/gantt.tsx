"use client";

import { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Lock, Calendar } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import {
  calculateCriticalPath,
  toCpmMap,
  type CpmInputDep,
} from "@/lib/schedule/cpm";
import {
  barLayout as calcBarLayout,
  computeBounds,
  describeBar,
  fmtDate,
  fmtRange,
  fmtSlip,
  iterDays,
  monthTicks,
  slipDays,
  toDay,
  type Span,
} from "@/lib/timeline";
import { TimelineBar, type TimelineBarPattern } from "@/components/timeline/timeline-bar";
import { TimelineTable } from "@/components/timeline/timeline-table";
import { useDateDisplayPref } from "@/lib/theme/use-appearance";

// ── Data shapes ───────────────────────────────────────────────────────────────

export interface TaskDependency {
  id: string;
  predecessor_id: string;
  successor_id: string;
  type: "FS" | "SS" | "FF" | "SF";
  lag_days: number;
}

export interface Milestone {
  id: string;
  project_id: string;
  name: string;
  target_date: string | null;
  baseline_target_date: string | null;
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
  baseline_start_date: string | null;
  baseline_due_date: string | null;
  completion_pct: number;
  sort_order: number;
  assignee_id: string | null;
}

interface GanttChartProps {
  projectId: string;
  milestones: Milestone[];
  tasks: Task[];
  isLocked: boolean;
  /** Optional task dependency rows. When provided, dependency arrows and
   *  critical-path tinting are rendered. Degrades gracefully when absent. */
  dependencies?: TaskDependency[];
}

// ── Constants ──────────────────────────────────────────────────────────────────

const ROW_H_MS = 44;    // milestone row height px
const ROW_H_TASK = 36;  // task row height px
const HEADER_H = 56;    // two-row header total height

// Day widths per view
const DAY_W: Record<"week" | "month", number> = {
  week: 36,
  month: 16,
};

// ── Bar colour families ───────────────────────────────────────────────────────

/** Returns { track, fill, ghost } Tailwind classes. */
function taskBarClasses(status_type: Task["status_type"]): {
  track: string;   // outer bar background (lighter)
  fill: string;    // inner progress fill (stronger)
  ghost: string;   // baseline ghost
} {
  switch (status_type) {
    case "completed":
      return {
        track: "bg-accent/20",
        fill:  "bg-accent",
        ghost: "bg-border-subtle",
      };
    case "started":
      return {
        track: "bg-success/20",
        fill:  "bg-success",
        ghost: "bg-border-subtle",
      };
    case "canceled":
      return {
        track: "bg-ink-muted/15",
        fill:  "bg-ink-muted/50",
        ghost: "bg-border-subtle",
      };
    case "backlog":
    case "unstarted":
    default:
      return {
        track: "bg-[var(--color-border-subtle)]",
        fill:  "bg-ink-muted/60",
        ghost: "bg-border-subtle",
      };
  }
}

function milestoneTrackClass(status: Milestone["status"]): string {
  switch (status) {
    case "completed": return "bg-accent";
    case "on_track":  return "bg-success";
    case "at_risk":   return "bg-warning";
    case "delayed":   return "bg-danger";
    default:          return "bg-ink-muted/40";
  }
}

// ── Diamond SVG ──────────────────────────────────────────────────────────────

function DiamondIcon({ className }: { className?: string }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 11 11"
      fill="currentColor"
      className={className}
    >
      <path d="M5.5 0L11 5.5L5.5 11L0 5.5L5.5 0Z" />
    </svg>
  );
}

// ── GanttChart ─────────────────────────────────────────────────────────────────

export function GanttChart({
  milestones,
  tasks,
  isLocked,
  dependencies = [],
}: GanttChartProps) {
  const [view, setView] = useState<"week" | "month">("month");
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const dayW = DAY_W[view];
  const pref = useDateDisplayPref();

  // ── CPM: critical path + dep arrows ───────────────────────────────────────

  const cpmMap = useMemo(() => {
    if (dependencies.length === 0) return new Map();
    const cpmDeps: CpmInputDep[] = dependencies.map((d) => ({
      predecessor_id: d.predecessor_id,
      successor_id: d.successor_id,
      type: d.type,
      lag_days: d.lag_days ?? 0,
    }));
    const results = calculateCriticalPath(tasks, cpmDeps);
    return toCpmMap(results);
  }, [tasks, dependencies]);

  /**
   * Build an ordered flat list of visible task rows (milestone tasks first,
   * then standalone tasks). Mirrors exactly the row order drawn in the
   * timeline so we can calculate Y-coordinates for arrow endpoints.
   *
   * Each entry carries the row's top-Y offset (relative to the row content
   * div, i.e. below HEADER_H).
   */
  const taskRowIndex = useMemo(() => {
    const index = new Map<string, number>(); // taskId → rowIndex (0-based)
    let rowIdx = 0;

    const sortedMsCopy = [...milestones].sort((a, b) => a.sort_order - b.sort_order);

    for (const ms of sortedMsCopy) {
      rowIdx++; // milestone row itself
      const msTasks = tasks
        .filter((t) => t.milestone_id === ms.id)
        .sort((a, b) => a.sort_order - b.sort_order);
      for (const t of msTasks) {
        index.set(t.id, rowIdx);
        rowIdx++;
      }
    }

    const standalone = tasks
      .filter((t) => !t.milestone_id)
      .sort((a, b) => a.sort_order - b.sort_order);
    for (const t of standalone) {
      index.set(t.id, rowIdx);
      rowIdx++;
    }

    return index;
  }, [milestones, tasks]);

  // ── Compute date bounds ────────────────────────────────────────────────────

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayDay = toDay(today);

  const { minDay, maxDay, totalDays } = useMemo(() => {
    const allDates = [
      ...milestones.flatMap((m) => [m.target_date, m.baseline_target_date]),
      ...tasks.flatMap((t) => [t.start_date, t.due_date, t.baseline_start_date, t.baseline_due_date]),
    ];
    return computeBounds(allDates, todayDay);
  }, [milestones, tasks, todayDay]);

  // ── Header ticks ──────────────────────────────────────────────────────────

  const monthHeaderTicks = useMemo(() => monthTicks(minDay, totalDays), [minDay, totalDays]);
  const weekTickCols = useMemo(
    () => iterDays(minDay, totalDays).flatMap((d, i) => (d.getDay() === 1 && i > 0 ? [i] : [])),
    [minDay, totalDays],
  );

  // Sub-header labels (weeks in month view, day numbers in week view)
  const subLabels = useMemo(() => {
    const result: { label: string; col: number }[] = [];
    const days = iterDays(minDay, totalDays);
    if (view === "month") {
      // Show week-start dates as sub labels
      days.forEach((d, i) => {
        if (d.getDay() === 1 || i === 0) {
          result.push({
            label: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
            col: i,
          });
        }
      });
    } else {
      // Week view: show day initials
      days.forEach((d, i) => {
        result.push({
          label: ["S", "M", "T", "W", "T", "F", "S"][d.getDay()],
          col: i,
        });
      });
    }
    return result;
  }, [minDay, totalDays, view]);

  const totalPx = totalDays * dayW;
  const todayOffset = (todayDay - minDay) * dayW;
  const todayVisible = todayDay >= minDay && todayDay <= maxDay;

  /**
   * Pre-compute per-task bar pixel layout so arrow rendering can look it up
   * without re-calling barLayout inside the SVG pass (minDay is now in scope).
   */
  const taskBarPixels = useMemo(() => {
    const map = new Map<string, Span>();
    for (const t of tasks) {
      const sp = calcBarLayout(t.start_date, t.due_date, minDay, dayW);
      if (sp) map.set(t.id, sp);
    }
    return map;
  }, [tasks, minDay, dayW]);

  // ── Bar layout helpers ─────────────────────────────────────────────────────

  function barLayout(start: string | null, end: string | null): Span | null {
    return calcBarLayout(start, end, minDay, dayW);
  }

  // ── Milestone bracket (span across its tasks) ──────────────────────────────

  function msBracketLayout(ms: Milestone): { left: number; width: number } | null {
    const msTasks = tasks.filter((t) => t.milestone_id === ms.id);
    const dates = msTasks.flatMap((t) => [t.start_date, t.due_date]).filter(Boolean) as string[];
    if (ms.target_date) dates.push(ms.target_date);
    if (dates.length < 2) return null;
    const days = dates.map(toDay);
    const left  = (Math.min(...days) - minDay) * dayW;
    const right = (Math.max(...days) - minDay) * dayW + dayW;
    return { left, width: Math.max(right - left, dayW) };
  }

  // ── Sorted rows ──────────────────────────────────────────────────────────

  const sortedMs = [...milestones].sort((a, b) => a.sort_order - b.sort_order);

  // ── Empty state ──────────────────────────────────────────────────────────

  if (milestones.length === 0 && tasks.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-border-subtle bg-surface py-20 text-center">
        <Calendar size={32} className="text-ink-muted opacity-30" />
        <p className="text-sm text-ink-secondary">No milestones or tasks yet.</p>
      </div>
    );
  }

  // ── Task row (shared by milestone-nested and standalone tasks) ─────────────

  const PATTERN: Record<Task["status_type"], TimelineBarPattern> = {
    completed: "solid",
    started: "plain",
    unstarted: "dashed",
    backlog: "dashed",
    canceled: "striped",
  };
  const STATUS_TEXT: Record<Task["status_type"], string> = {
    completed: "completed",
    started: "in progress",
    unstarted: "not started",
    backlog: "backlog",
    canceled: "canceled",
  };

  function taskTableRow(t: Task) {
    return [
      t.name,
      "Task",
      fmtRange(t.start_date, t.due_date, pref),
      STATUS_TEXT[t.status_type],
      `${t.completion_pct}%`,
      cpmMap.get(t.id)?.isCritical ? "yes" : "no",
      fmtSlip(slipDays(t.due_date, t.baseline_due_date)) ?? "none",
    ];
  }

  function renderTaskRow(t: Task) {
    const bp = barLayout(t.start_date, t.due_date);
    const bpBaseline = barLayout(t.baseline_start_date, t.baseline_due_date);
    const cls = taskBarClasses(t.status_type);
    const showPct = (bp?.width ?? 0) >= 32;
    const isCritical = cpmMap.get(t.id)?.isCritical ?? false;
    const slip = slipDays(t.due_date, t.baseline_due_date);
    const taskSlip = fmtSlip(slip);

    return (
      <div
        key={t.id}
        className="relative border-b border-border-subtle"
        style={{ height: ROW_H_TASK, width: totalPx }}
      >
        {bp && (
          <>
            {/* Baseline ghost bar (behind current bar) */}
            {bpBaseline && (
              <div
                className="absolute top-1/2 -translate-y-1/2 h-4 rounded-full opacity-25 pointer-events-none"
                style={{
                  left:       bpBaseline.left,
                  width:      bpBaseline.width,
                  background: "var(--color-border-strong)",
                }}
                aria-hidden
              />
            )}

            {/* Critical-path ring (outline) */}
            {isCritical && (
              <div
                className="absolute top-1/2 -translate-y-1/2 h-5 rounded-full pointer-events-none"
                style={{
                  left:   bp.left - 2,
                  width:  bp.width + 4,
                  outline: "2px solid var(--color-danger)",
                  outlineOffset: 1,
                }}
                aria-hidden
              />
            )}

            {/* Track bar */}
            <TimelineBar
              label={describeBar({
                name: t.name,
                start: t.start_date,
                end: t.due_date,
                status: STATUS_TEXT[t.status_type],
                progressPct: t.completion_pct,
                critical: isCritical,
                slip,
                pref,
              })}
              pattern={PATTERN[t.status_type]}
              className={cn(
                "absolute top-1/2 -translate-y-1/2 h-5 rounded-full overflow-hidden flex items-center",
                cls.track
              )}
              style={{ left: bp.left, width: bp.width }}
            >
              {/* Progress fill */}
              <div
                className={cn("h-full rounded-full transition-all duration-300", cls.fill)}
                style={{ width: `${Math.min(t.completion_pct, 100)}%` }}
              />
              {/* % label */}
              {showPct && t.completion_pct > 0 && (
                <span className="absolute inset-0 flex items-center justify-center select-none pointer-events-none">
                  {/* ink on a canvas chip: >=4.5:1 over any track/fill, both themes */}
                  <span className="rounded-sm bg-canvas/85 px-1 text-xs font-semibold leading-4 text-ink">
                    {t.completion_pct}%
                  </span>
                </span>
              )}
            </TimelineBar>

            {/* Slip indicator label to the right of the bar */}
            {taskSlip && (
              <span
                className="absolute top-1/2 -translate-y-1/2 font-mono text-xs font-semibold text-warning-ink select-none pointer-events-none whitespace-nowrap"
                style={{ left: bp.left + bp.width + 4 }}
                title={`Slipped ${taskSlip} vs baseline`}
              >
                {taskSlip}
              </span>
            )}
          </>
        )}
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {isLocked && (
            <Badge tone="neutral" className="gap-1">
              <Lock size={10} />
              Locked baseline
            </Badge>
          )}
        </div>
        {/* View toggle */}
        <div className="flex items-center rounded-lg border border-border-subtle bg-sunken p-0.5 gap-0.5 shrink-0">
          {(["week", "month"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={cn(
                "focus-ring rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-200 min-h-[44px] sm:min-h-[36px]",
                view === v
                  ? "bg-surface text-ink shadow-sm"
                  : "text-ink-secondary hover:text-ink"
              )}
            >
              {v === "week" ? "Week" : "Month"}
            </button>
          ))}
        </div>
      </div>

      {/* Gantt card — outer overflow-x-auto so entire chart scrolls on mobile */}
      <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface shadow-sm">
        <div className="flex" style={{ minWidth: 480 }}>

          {/* ── Left sticky label column ─────────────────────────────────── */}
          <div
            className={cn(
              "shrink-0 sticky left-0 z-20 bg-surface border-r border-border-subtle flex flex-col transition-all duration-200",
              leftCollapsed ? "w-10" : "w-40 sm:w-60"
            )}
          >
            {/* Header cell with collapse toggle */}
            <div
              className="flex items-center justify-between border-b border-border-subtle bg-sunken/60 px-3"
              style={{ height: HEADER_H }}
            >
              {!leftCollapsed && (
                <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted select-none">
                  Name
                </span>
              )}
              <button
                onClick={() => setLeftCollapsed((c) => !c)}
                className="focus-ring relative ml-auto rounded-md p-1 text-ink-muted hover:text-ink hover:bg-sunken transition-colors duration-150 before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
                aria-label={leftCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                aria-expanded={!leftCollapsed}
              >
                {leftCollapsed
                  ? <ChevronRight size={13} aria-hidden />
                  : <ChevronLeft size={13} aria-hidden />
                }
              </button>
            </div>

            {/* Milestone + task label rows */}
            {sortedMs.map((ms) => {
              const msTasks = tasks
                .filter((t) => t.milestone_id === ms.id)
                .sort((a, b) => a.sort_order - b.sort_order);

              return (
                <div key={ms.id}>
                  {/* Milestone label row */}
                  <div
                    className="flex items-center gap-2 border-b border-border-subtle px-3"
                    style={{ height: ROW_H_MS }}
                  >
                    <DiamondIcon className={cn("shrink-0", milestoneTrackClass(ms.status))} />
                    {!leftCollapsed && (
                      <span className="text-[13px] font-semibold text-ink truncate">
                        {ms.name}
                      </span>
                    )}
                  </div>

                  {/* Task label rows */}
                  {msTasks.map((t) => (
                    <div
                      key={t.id}
                      className="flex items-center gap-2 border-b border-border-subtle pl-6 pr-3"
                      style={{ height: ROW_H_TASK }}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-border-strong shrink-0" />
                      {!leftCollapsed && (
                        <span className="text-[12px] text-ink-secondary truncate">
                          {t.name}
                        </span>
                      )}
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
                <div
                  key={t.id}
                  className="flex items-center gap-2 border-b border-border-subtle px-3"
                  style={{ height: ROW_H_TASK }}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-border-strong shrink-0" />
                  {!leftCollapsed && (
                    <span className="text-[12px] text-ink-secondary truncate">
                      {t.name}
                    </span>
                  )}
                </div>
              ))}
          </div>

          {/* ── Right scrollable timeline ─────────────────────────────────── */}
          <div
            ref={scrollRef}
            className="overflow-x-auto flex-1 relative"
            style={{ WebkitOverflowScrolling: "touch" }}
          >
            <div style={{ width: totalPx, position: "relative", minWidth: totalPx }}>

              {/* ── Two-row sticky header ──────────────────────────────────── */}
              <div
                className="sticky top-0 z-10 bg-sunken/80 backdrop-blur-sm border-b border-border-subtle"
                style={{ height: HEADER_H, width: totalPx }}
              >
                {/* Row 1: month labels */}
                <div className="relative" style={{ height: HEADER_H / 2 }}>
                  {monthHeaderTicks.map((t) => (
                    <div
                      key={t.label + t.col}
                      className="absolute top-0 bottom-0 flex items-center px-2 pointer-events-none"
                      style={{ left: t.col * dayW }}
                    >
                      {/* Strong month gridline */}
                      <div
                        className="absolute left-0 top-0 bottom-0 w-px bg-border-subtle"
                        style={{ opacity: 0.6 }}
                      />
                      <span className="text-xs font-semibold text-ink-secondary whitespace-nowrap select-none">
                        {t.label}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Row 2: sub-labels (week starts in month view / day initials in week view) */}
                <div
                  className="relative border-t border-border-subtle/40"
                  style={{ height: HEADER_H / 2 }}
                >
                  {subLabels.map((sl, i) => (
                    <div
                      key={`${sl.col}-${i}`}
                      className="absolute top-0 bottom-0 flex items-center pointer-events-none"
                      style={{
                        left: sl.col * dayW,
                        width: view === "week" ? dayW : undefined,
                        justifyContent: view === "week" ? "center" : "flex-start",
                        paddingLeft: view === "month" ? 4 : 0,
                      }}
                    >
                      <span className="text-xs text-ink-muted whitespace-nowrap select-none">
                        {sl.label}
                      </span>
                    </div>
                  ))}

                  {/* Today pill in header */}
                  {todayVisible && (
                    <div
                      className="absolute top-1/2 -translate-y-1/2 flex flex-col items-center pointer-events-none"
                      style={{ left: todayOffset }}
                    >
                      <div className="rounded-full bg-accent px-1.5 py-0.5">
                        <span className="text-xs font-bold text-accent-ink whitespace-nowrap select-none">
                          Today
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ── Background gridlines ──────────────────────────────────── */}
              <div
                className="absolute inset-x-0 pointer-events-none"
                style={{ top: HEADER_H, bottom: 0 }}
              >
                {/* Month strong lines */}
                {monthHeaderTicks.map((t) => (
                  <div
                    key={`grid-major-${t.col}`}
                    className="absolute top-0 bottom-0 w-px bg-border-subtle"
                    style={{ left: t.col * dayW, opacity: 0.5 }}
                  />
                ))}
                {/* Week faint lines */}
                {weekTickCols.map((col, i) => (
                  <div
                    key={`grid-minor-${i}`}
                    className="absolute top-0 bottom-0 w-px bg-border-subtle"
                    style={{ left: col * dayW, opacity: 0.25 }}
                  />
                ))}
                {/* Today line */}
                {todayVisible && (
                  <div
                    className="absolute top-0 bottom-0 w-px bg-accent"
                    style={{ left: todayOffset, opacity: 0.6 }}
                  />
                )}
              </div>

              {/* ── Row content ───────────────────────────────────────────── */}
              <div style={{ position: "relative" }}>
                {sortedMs.map((ms) => {
                  const msTasks = tasks
                    .filter((t) => t.milestone_id === ms.id)
                    .sort((a, b) => a.sort_order - b.sort_order);

                  const diamondLeft = ms.target_date
                    ? (toDay(ms.target_date) - minDay) * dayW + dayW / 2
                    : null;

                  // Baseline diamond for milestone
                  const baselineDiamondLeft = ms.baseline_target_date
                    ? (toDay(ms.baseline_target_date) - minDay) * dayW + dayW / 2
                    : null;

                  // Milestone slip
                  const msSlip = fmtSlip(slipDays(ms.target_date, ms.baseline_target_date));

                  const bracket = msBracketLayout(ms);

                  return (
                    <div key={ms.id}>
                      {/* Milestone row */}
                      <div
                        className="relative border-b border-border-subtle"
                        style={{ height: ROW_H_MS, width: totalPx }}
                      >
                        {/* Faint bracket across tasks span */}
                        {bracket && (
                          <div
                            className="absolute top-1/2 -translate-y-1/2 rounded-sm"
                            style={{
                              left:   bracket.left,
                              width:  bracket.width,
                              height: 2,
                              background: "var(--color-border-strong)",
                              opacity: 0.35,
                            }}
                          />
                        )}

                        {/* Baseline diamond at baseline_target_date (ghost, faint) */}
                        {baselineDiamondLeft !== null && (
                          <div
                            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 flex items-center justify-center"
                            style={{ left: baselineDiamondLeft, opacity: 0.3 }}
                            title={`Baseline target: ${fmtDate(ms.baseline_target_date, pref)}`}
                            aria-hidden
                          >
                            <DiamondIcon className="w-3.5 h-3.5 text-ink-muted" />
                          </div>
                        )}

                        {/* Diamond at target_date */}
                        {diamondLeft !== null && (
                          <TimelineBar
                            label={describeBar({
                              kind: "Milestone",
                              name: ms.name,
                              end: ms.target_date,
                              status: ms.status.replace("_", " "),
                              slip: slipDays(ms.target_date, ms.baseline_target_date),
                              pref,
                            })}
                            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 flex items-center rounded-sm"
                            style={{ left: diamondLeft }}
                          >
                            <DiamondIcon
                              className={cn("w-3.5 h-3.5", milestoneTrackClass(ms.status))}
                            />
                            {/* Slip indicator */}
                            {msSlip && (
                              <span className="ml-0.5 font-mono text-xs font-semibold text-warning-ink select-none whitespace-nowrap">
                                {msSlip}
                              </span>
                            )}
                          </TimelineBar>
                        )}
                      </div>

                      {/* Task rows */}
                      {msTasks.map(renderTaskRow)}
                    </div>
                  );
                })}

                {/* Standalone tasks */}
                {tasks
                  .filter((t) => !t.milestone_id)
                  .sort((a, b) => a.sort_order - b.sort_order)
                  .map(renderTaskRow)}

                {/* ── Dependency arrows SVG overlay ─────────────────────────── */}
                {dependencies.length > 0 && (() => {
                  // Compute total height of the row area to size the SVG
                  const sortedMsCopy2 = [...milestones].sort((a, b) => a.sort_order - b.sort_order);
                  let totalRowH = 0;
                  for (const ms of sortedMsCopy2) {
                    totalRowH += ROW_H_MS;
                    const msTasks = tasks.filter((t) => t.milestone_id === ms.id);
                    totalRowH += msTasks.length * ROW_H_TASK;
                  }
                  const standaloneCnt = tasks.filter((t) => !t.milestone_id).length;
                  totalRowH += standaloneCnt * ROW_H_TASK;

                  const arrows = dependencies.flatMap((dep) => {
                    const predRowIdx = taskRowIndex.get(dep.predecessor_id);
                    const succRowIdx = taskRowIndex.get(dep.successor_id);
                    if (predRowIdx === undefined || succRowIdx === undefined) return [];

                    const predBar = taskBarPixels.get(dep.predecessor_id);
                    const succBar = taskBarPixels.get(dep.successor_id);
                    if (!predBar || !succBar) return [];

                    // For each row index, accumulate its Y position
                    // Row index 0 is a milestone row (ROW_H_MS), subsequent task rows are ROW_H_TASK.
                    // We walk the same structure used in taskRowIndex to compute Y offsets.
                    const getRowY = (rowIdx: number): number => {
                      const sortedMsLocal = [...milestones].sort((a, b) => a.sort_order - b.sort_order);
                      let y = 0;
                      let idx = 0;
                      for (const ms of sortedMsLocal) {
                        if (idx === rowIdx) return y + ROW_H_MS / 2;
                        y += ROW_H_MS;
                        idx++;
                        const msTasks = tasks
                          .filter((t) => t.milestone_id === ms.id)
                          .sort((a, b) => a.sort_order - b.sort_order);
                        for (let i = 0; i < msTasks.length; i++) {
                          if (idx === rowIdx) return y + ROW_H_TASK / 2;
                          y += ROW_H_TASK;
                          idx++;
                        }
                      }
                      const standalone = tasks
                        .filter((t) => !t.milestone_id)
                        .sort((a, b) => a.sort_order - b.sort_order);
                      for (let i = 0; i < standalone.length; i++) {
                        if (idx === rowIdx) return y + ROW_H_TASK / 2;
                        y += ROW_H_TASK;
                        idx++;
                      }
                      return y;
                    };

                    const x1 = predBar.left + predBar.width; // right edge of predecessor bar
                    const y1 = getRowY(predRowIdx);
                    const x2 = succBar.left;                 // left edge of successor bar
                    const y2 = getRowY(succRowIdx);

                    const isCrit =
                      (cpmMap.get(dep.predecessor_id)?.isCritical ?? false) &&
                      (cpmMap.get(dep.successor_id)?.isCritical ?? false);

                    const color = isCrit ? "var(--color-danger)" : "var(--color-border-strong)";
                    const opacity = isCrit ? 0.85 : 0.5;

                    // Elbow path: right → down/up → right
                    const midX = x1 + Math.max((x2 - x1) / 2, 12);
                    const d = `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;

                    return [{ d, color, opacity, key: `${dep.predecessor_id}→${dep.successor_id}`, x2, y2 }];
                  });

                  if (arrows.length === 0) return null;

                  return (
                    <svg
                      className="absolute inset-0 pointer-events-none"
                      width={totalPx}
                      height={totalRowH}
                      style={{ overflow: "visible" }}
                    >
                      <defs>
                        <marker
                          id="arrow-normal"
                          markerWidth="6"
                          markerHeight="6"
                          refX="5"
                          refY="3"
                          orient="auto"
                        >
                          <path d="M0,0 L6,3 L0,6 Z" fill="var(--color-border-strong)" opacity="0.5" />
                        </marker>
                        <marker
                          id="arrow-critical"
                          markerWidth="6"
                          markerHeight="6"
                          refX="5"
                          refY="3"
                          orient="auto"
                        >
                          <path d="M0,0 L6,3 L0,6 Z" fill="var(--color-danger)" opacity="0.85" />
                        </marker>
                      </defs>
                      {arrows.map((arrow) => (
                        <path
                          key={arrow.key}
                          d={arrow.d}
                          stroke={arrow.color}
                          strokeOpacity={arrow.opacity}
                          strokeWidth={1.5}
                          fill="none"
                          markerEnd={arrow.color === "var(--color-danger)" ? "url(#arrow-critical)" : "url(#arrow-normal)"}
                        />
                      ))}
                    </svg>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Text alternative for the chart */}
      <TimelineTable
        caption="Schedule: milestones and tasks with dates, status, critical path and slip against baseline"
        columns={["Item", "Type", "Dates", "Status", "Progress", "Critical path", "Slip vs baseline"]}
        rows={[
          ...sortedMs.flatMap((ms) => [
            [
              ms.name,
              "Milestone",
              fmtDate(ms.target_date, pref),
              ms.status.replace("_", " "),
              `${ms.completion_pct}%`,
              "-",
              fmtSlip(slipDays(ms.target_date, ms.baseline_target_date)) ?? "none",
            ],
            ...tasks
              .filter((t) => t.milestone_id === ms.id)
              .sort((a, b) => a.sort_order - b.sort_order)
              .map(taskTableRow),
          ]),
          ...tasks
            .filter((t) => !t.milestone_id)
            .sort((a, b) => a.sort_order - b.sort_order)
            .map(taskTableRow),
        ]}
      />

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-1">
        {[
          { label: "Completed",   bg: "bg-accent/70" },
          { label: "In progress", bg: "bg-success/70" },
          { label: "Not started", bg: "bg-border-strong" },
          { label: "Canceled",    bg: "bg-ink-muted/40" },
        ].map(({ label, bg }) => (
          <div key={label} className="flex items-center gap-1.5">
            <span className={cn("h-2 w-4 rounded-full", bg)} />
            <span className="text-xs text-ink-muted">{label}</span>
          </div>
        ))}
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-px bg-accent/60" style={{ display: "inline-block" }} />
          <span className="text-xs text-ink-muted">Today</span>
        </div>
        {/* Baseline legend entry — shown when any task/milestone has baseline data */}
        {(tasks.some((t) => t.baseline_start_date || t.baseline_due_date) ||
          milestones.some((m) => m.baseline_target_date)) && (
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-4 rounded-full bg-border-strong opacity-30" />
            <span className="text-xs text-ink-muted">Baseline</span>
          </div>
        )}
        {dependencies.length > 0 && (
          <>
            <div className="flex items-center gap-1.5">
              <span
                className="inline-block h-0 w-4 rounded-full"
                style={{ borderTop: "2px solid var(--color-danger)", opacity: 0.85 }}
              />
              <span className="text-xs text-ink-muted">Critical path</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className="inline-block h-0 w-4 rounded-full"
                style={{ borderTop: "2px solid var(--color-border-strong)", opacity: 0.5 }}
              />
              <span className="text-xs text-ink-muted">Dependency</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

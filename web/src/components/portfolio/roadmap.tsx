"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { ragLabel, type RagStatus } from "@/lib/status";
import {
  barLayout as calcBarLayout,
  computeBounds,
  describeBar,
  fitDayWidth,
  fmtDate,
  fmtRange,
  fmtSlip,
  markerX,
  monthTicks as calcMonthTicks,
  slipDays,
  toDay,
  type Span,
} from "@/lib/timeline";
import { TimelineBar, type TimelineBarPattern } from "@/components/timeline/timeline-bar";
import { TimelineTable } from "@/components/timeline/timeline-table";
import { TimelineControls } from "@/components/timeline/timeline-controls";
import { useElementWidth, useOpenOnToday } from "@/components/timeline/use-timeline-viewport";
import { useDateDisplayPref } from "@/lib/theme/use-appearance";

// ── Data shapes ───────────────────────────────────────────────────────────────

export interface PortfolioProject {
  id: string;
  code: string;
  name: string;
  rag_status: RagStatus;
  completion_pct: number | null;
  start_date: string | null;
  target_date: string | null;
}

export interface PortfolioMilestone {
  project_id: string;
  name: string;
  target_date: string | null;
  baseline_target_date: string | null;
  status: "not_started" | "on_track" | "at_risk" | "delayed" | "completed";
  completion_pct: number;
}

interface RoadmapProps {
  projects: PortfolioProject[];
  milestones: PortfolioMilestone[];
  /**
   * Earliest / latest date across EVERY program group on the page. Passed to
   * each group's roadmap so all of them plot on the same time axis and line up
   * when read down the page. Omit for a standalone roadmap (own range).
   */
  axisSpan?: { from: string | null; to: string | null };
  /** True when the empty roadmap is the result of a filter, not a lack of data. */
  filtered?: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ROW_H = 48;        // swim-lane row height px
const HEADER_H = 48;     // one-row month header height
const DAY_W = 14;        // px per day (month view)

// ── RAG bar colour ─────────────────────────────────────────────────────────────

function ragBarClass(rag: RagStatus | string): string {
  switch (rag) {
    case "green":       return "bg-success/30";
    case "complete":    return "bg-accent/30";
    case "amber":       return "bg-warning/30";
    case "red":         return "bg-danger/30";
    case "not_started":
    default:            return "bg-info/20";
  }
}

function ragProgressClass(rag: RagStatus | string): string {
  switch (rag) {
    case "green":       return "bg-success/70";
    case "complete":    return "bg-accent/70";
    case "amber":       return "bg-warning/70";
    case "red":         return "bg-danger/70";
    case "not_started":
    default:            return "bg-info/50";
  }
}

function ragDotClass(rag: RagStatus | string): string {
  switch (rag) {
    case "green":       return "bg-success";
    case "complete":    return "bg-accent";
    case "amber":       return "bg-warning";
    case "red":         return "bg-danger";
    case "not_started":
    default:            return "bg-info";
  }
}

function milestoneColor(status: PortfolioMilestone["status"]): string {
  switch (status) {
    case "completed":  return "text-accent";
    case "on_track":   return "text-success-ink";
    case "at_risk":    return "text-warning-ink";
    case "delayed":    return "text-danger-ink";
    default:           return "text-ink-muted";
  }
}

const RAG_PATTERN: Record<string, TimelineBarPattern> = {
  green: "plain",
  amber: "plain",
  red: "plain",
  complete: "solid",
  not_started: "dashed",
};

// ── Diamond SVG ──────────────────────────────────────────────────────────────

function DiamondIcon({ className }: { className?: string }) {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor" className={className}>
      <path d="M5.5 0L11 5.5L5.5 11L0 5.5L5.5 0Z" />
    </svg>
  );
}

// ── PortfolioRoadmap ──────────────────────────────────────────────────────────

export function PortfolioRoadmap({ projects, milestones, axisSpan, filtered = false }: RoadmapProps) {
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [fit, setFit] = useState(false);

  const pref = useDateDisplayPref();
  const windowPx = useElementWidth(scrollRef);

  // ── Date bounds ───────────────────────────────────────────────────────────

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const todayDay = toDay(today);

  const { minDay, maxDay, totalDays } = useMemo(() => {
    const allDates: Array<string | null> = [];
    for (const p of projects) allDates.push(p.start_date, p.target_date);
    for (const m of milestones) allDates.push(m.target_date, m.baseline_target_date);
    if (axisSpan) allDates.push(axisSpan.from, axisSpan.to);
    return computeBounds(allDates, todayDay, { fallbackBefore: 30, fallbackAfter: 90 });
  }, [projects, milestones, axisSpan, todayDay]);

  // Fit: px/day so the whole range fills the window; otherwise the readable 14px/day.
  const dayW = fit ? fitDayWidth(windowPx, totalDays, { min: 0.5, max: 24, fallback: DAY_W }) : DAY_W;
  const totalPx = totalDays * dayW;
  const todayOffset = (todayDay - minDay) * dayW;
  const todayVisible = todayDay >= minDay && todayDay <= maxDay;

  // Open on today (the range is months wide and starts well before it), and
  // offer a jump back to it.
  const { scrollToToday } = useOpenOnToday({
    scrollRef,
    todayX: todayVisible ? todayOffset : null,
    contentPx: totalPx,
    dayW,
    resetKey: `${fit}`,
  });

  // ── Month gridline ticks ──────────────────────────────────────────────────

  const monthTicks = useMemo(() => calcMonthTicks(minDay, totalDays, "short"), [minDay, totalDays]);

  // ── Bar layout helper ─────────────────────────────────────────────────────

  function barLayout(start: string | null, end: string | null): Span | null {
    return calcBarLayout(start, end, minDay, dayW);
  }

  // ── Group milestones by project ───────────────────────────────────────────

  const milestonesByProject = useMemo(() => {
    const map = new Map<string, PortfolioMilestone[]>();
    for (const m of milestones) {
      const arr = map.get(m.project_id) ?? [];
      arr.push(m);
      map.set(m.project_id, arr);
    }
    return map;
  }, [milestones]);

  // ── Empty state ───────────────────────────────────────────────────────────

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-border-subtle bg-surface py-20 text-center">
        <Calendar size={32} className="text-ink-muted opacity-30" />
        {filtered ? (
          <>
            <p className="text-sm text-ink-secondary">No projects match these filters.</p>
            <p className="text-xs text-ink-muted">Clear the program or health filter to see the roadmap again.</p>
          </>
        ) : (
          <>
            <p className="text-sm text-ink-secondary">No projects with dates yet.</p>
            <p className="text-xs text-ink-muted">Add start and target dates to your projects to see them here.</p>
          </>
        )}
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-3">
      <TimelineControls
        onToday={scrollToToday}
        todayAvailable={todayVisible}
        fit={fit}
        onFitChange={setFit}
        className="justify-end"
      />
      {/* Outer chart card */}
      <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface">
        <div className="flex" style={{ minWidth: 480 }}>

          {/* ── Left rail ──────────────────────────────────────────────────── */}
          <div
            className={cn(
              "shrink-0 sticky left-0 z-20 bg-surface border-r border-border-subtle flex flex-col transition-all duration-200",
              // narrower on phones: the window beside the rail was only ~260px
              railCollapsed ? "w-12" : "w-[10.5rem] sm:w-[220px]",
            )}
          >
            {/* Rail header */}
            <div
              className="flex items-center justify-between border-b border-border-subtle bg-sunken/60 px-3"
              style={{ height: HEADER_H }}
            >
              {!railCollapsed && (
                <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted select-none">
                  Project
                </span>
              )}
              <button
                type="button"
                onClick={() => setRailCollapsed((v) => !v)}
                className="focus-ring relative ml-auto rounded-md p-1 text-ink-muted hover:text-ink hover:bg-sunken transition-colors duration-150 before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
                aria-label={railCollapsed ? "Expand project rail" : "Collapse project rail"}
                aria-expanded={!railCollapsed}
              >
                {railCollapsed ? <ChevronRight size={13} aria-hidden /> : <ChevronLeft size={13} aria-hidden />}
              </button>
            </div>

            {/* Project label rows */}
            {projects.map((project) => {
              const pct = Math.min(100, Math.max(0, project.completion_pct ?? 0));
              return (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}`}
                  className="focus-ring flex items-center gap-2 border-b border-border-subtle px-3 cursor-pointer hover:bg-sunken/60 transition-colors duration-100"
                  style={{ height: ROW_H }}
                  title={`${project.code} — ${project.name}`}
                  aria-label={`Open project ${project.code} ${project.name}, ${ragLabel(project.rag_status)}`}
                >
                  {/* RAG dot */}
                  <span
                    className={cn("h-2 w-2 rounded-full shrink-0", ragDotClass(project.rag_status))}
                    aria-hidden
                  />
                  {!railCollapsed && (
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-mono text-xs text-ink-muted shrink-0">
                          {project.code}
                        </span>
                        <span className="text-[12px] font-medium text-ink truncate">
                          {project.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-1 flex-1 min-w-0 overflow-hidden rounded-full bg-sunken">
                          <div
                            className="h-full rounded-full bg-accent/60 transition-all duration-300"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="font-mono text-xs text-ink-muted tabular-nums shrink-0">
                          {pct}%
                        </span>
                      </div>
                    </div>
                  )}
                </Link>
              );
            })}
          </div>

          {/* ── Timeline ────────────────────────────────────────────────────── */}
          <div
            ref={scrollRef}
            className="overflow-x-auto flex-1 relative"
            style={{ WebkitOverflowScrolling: "touch" } as React.CSSProperties}
          >
            <div style={{ width: totalPx, position: "relative", minWidth: totalPx }}>

              {/* Month header */}
              <div
                className="sticky top-0 z-10 bg-sunken border-b border-border-subtle relative"
                style={{ height: HEADER_H, width: totalPx }}
              >
                {monthTicks.map((tick, ti) => {
                  // A partial first month can sit < ~6 days before the next tick;
                  // its label would overprint the next one, so drop that label.
                  const next = monthTicks[ti + 1];
                  const showLabel = !next || (next.col - tick.col) * dayW >= 64;
                  return (
                  <div
                    key={`${tick.label}-${tick.col}`}
                    className="absolute top-0 bottom-0 flex items-center px-2 pointer-events-none"
                    style={{ left: tick.col * dayW }}
                  >
                    <div
                      className="absolute left-0 top-0 bottom-0 w-px bg-border-subtle"
                      style={{ opacity: 0.5 }}
                    />
                    {showLabel && (
                      <span className="text-xs font-semibold text-ink-secondary whitespace-nowrap select-none">
                        {tick.label}
                      </span>
                    )}
                  </div>
                  );
                })}
                {/* Today pill */}
                {todayVisible && (
                  <div
                    className="absolute top-1/2 -translate-y-1/2 pointer-events-none"
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

              {/* Background gridlines */}
              <div
                className="absolute inset-x-0 pointer-events-none"
                style={{ top: HEADER_H, bottom: 0 }}
              >
                {monthTicks.map((tick) => (
                  <div
                    key={`grid-${tick.col}`}
                    className="absolute top-0 bottom-0 w-px bg-border-subtle"
                    style={{ left: tick.col * dayW, opacity: 0.4 }}
                  />
                ))}
                {todayVisible && (
                  <div
                    className="absolute top-0 bottom-0 w-px bg-accent"
                    style={{ left: todayOffset, opacity: 0.5 }}
                  />
                )}
              </div>

              {/* Swim-lane rows */}
              <div style={{ position: "relative" }}>
                {projects.map((project) => {
                  const bar = barLayout(project.start_date, project.target_date);
                  const pms = milestonesByProject.get(project.id) ?? [];
                  const open = () => router.push(`/projects/${project.id}`);

                  return (
                    <div
                      key={project.id}
                      className="relative border-b border-border-subtle cursor-pointer group"
                      style={{ height: ROW_H, width: totalPx }}
                      onClick={open}
                    >
                      {/* Hover tint */}
                      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 bg-sunken/40 transition-opacity duration-100 pointer-events-none" />

                      {/* Project span bar */}
                      {bar && (
                        <TimelineBar
                          label={describeBar({
                            kind: "Project",
                            name: project.name,
                            start: project.start_date,
                            end: project.target_date,
                            status: ragLabel(project.rag_status),
                            progressPct: project.completion_pct,
                            pref,
                          })}
                          onActivate={open}
                          pattern={RAG_PATTERN[project.rag_status] ?? "plain"}
                          className={cn(
                            "absolute top-1/2 -translate-y-1/2 rounded-md h-6 overflow-hidden",
                            ragBarClass(project.rag_status),
                          )}
                          style={{ left: bar.left, width: bar.width }}
                        >
                          {/* progress fill */}
                          <div
                            className={cn(
                              "h-full rounded-md transition-all duration-300",
                              ragProgressClass(project.rag_status),
                            )}
                            style={{ width: `${Math.min(project.completion_pct ?? 0, 100)}%` }}
                          />
                          {/* status as text, not colour alone (shown when it fits) */}
                          {bar.width >= 90 && (
                            <span className="absolute inset-0 flex items-center px-2 text-xs font-medium text-ink select-none pointer-events-none truncate">
                              {ragLabel(project.rag_status)}
                            </span>
                          )}
                        </TimelineBar>
                      )}

                      {/* Milestone diamonds */}
                      {pms.map((ms, idx) => {
                        if (!ms.target_date) return null;
                        const left = markerX(ms.target_date, minDay, dayW);
                        const slip = slipDays(ms.target_date, ms.baseline_target_date);
                        const slipLabel = fmtSlip(slip);
                        const hasSlip = slip !== null && slip > 0;

                        // baseline ghost diamond
                        const baselineLeft = ms.baseline_target_date
                          ? markerX(ms.baseline_target_date, minDay, dayW)
                          : null;

                        return (
                          <span key={idx}>
                            {/* baseline ghost */}
                            {baselineLeft !== null && (
                              <div
                                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 pointer-events-none"
                                style={{ left: baselineLeft, opacity: 0.25 }}
                                aria-hidden
                              >
                                <DiamondIcon className="text-ink-muted w-3 h-3" />
                              </div>
                            )}

                            {/* current diamond */}
                            <TimelineBar
                              label={describeBar({
                                kind: "Milestone",
                                name: ms.name,
                                end: ms.target_date,
                                status: ms.status.replace("_", " "),
                                slip,
                                pref,
                              })}
                              onActivate={open}
                              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 flex items-center rounded-sm"
                              style={{ left }}
                            >
                              <DiamondIcon
                                className={cn("w-3.5 h-3.5", milestoneColor(ms.status))}
                              />
                              {hasSlip && slipLabel && (
                                <span className="ml-0.5 font-mono text-xs font-semibold text-warning-ink select-none whitespace-nowrap pointer-events-none">
                                  {slipLabel}
                                </span>
                              )}
                            </TimelineBar>
                          </span>
                        );
                      })}
                    </div>
                  );
                })}
              </div>

            </div>
          </div>
        </div>
      </div>

      {/* Text alternative for the chart */}
      <TimelineTable
        caption="Portfolio roadmap: projects and milestones with dates, status and slip against baseline"
        columns={["Item", "Type", "Dates", "Status", "Progress", "Slip vs baseline"]}
        rows={projects.flatMap((p) => [
          [
            `${p.code} ${p.name}`,
            "Project",
            fmtRange(p.start_date, p.target_date, pref),
            ragLabel(p.rag_status),
            `${p.completion_pct ?? 0}%`,
            "-",
          ],
          ...(milestonesByProject.get(p.id) ?? []).map((m) => [
            m.name,
            "Milestone",
            fmtDate(m.target_date, pref),
            m.status.replace("_", " "),
            `${m.completion_pct}%`,
            fmtSlip(slipDays(m.target_date, m.baseline_target_date)) ?? "none",
          ]),
        ])}
      />

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-1">
        {/* RAG colours */}
        {/* labels come from ragLabel so the legend can never disagree with the bars' own text */}
        {[
          { label: ragLabel("green"),       bg: "bg-success/50" },
          { label: ragLabel("amber"),       bg: "bg-warning/50" },
          { label: ragLabel("red"),         bg: "bg-danger/50" },
          { label: ragLabel("complete"),    bg: "bg-accent/50" },
          { label: ragLabel("not_started"), bg: "bg-info/30" },
        ].map(({ label, bg }) => (
          <div key={label} className="flex items-center gap-1.5">
            <span className={cn("h-2 w-4 rounded-sm", bg)} />
            <span className="text-xs text-ink-muted">{label}</span>
          </div>
        ))}

        {/* Milestone marker */}
        <div className="flex items-center gap-1.5">
          <DiamondIcon className="text-ink-secondary w-3 h-3" />
          <span className="text-xs text-ink-muted">Milestone</span>
        </div>

        {/* Baseline slip */}
        {milestones.some((m) => m.baseline_target_date) && (
          <>
            <div className="flex items-center gap-1.5">
              <DiamondIcon className="text-ink-muted opacity-30 w-3 h-3" />
              <span className="text-xs text-ink-muted">Baseline</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-xs font-semibold text-warning-ink">+Nd</span>
              <span className="text-xs text-ink-muted">Slip vs baseline</span>
            </div>
          </>
        )}

        {/* Today */}
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-px bg-accent/70" />
          <span className="text-xs text-ink-muted">Today</span>
        </div>
      </div>
    </div>
  );
}

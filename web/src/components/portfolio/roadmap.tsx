"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { ragLabel, type RagStatus } from "@/lib/status";

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
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ROW_H = 48;        // swim-lane row height px
const HEADER_H = 48;     // one-row month header height
const RAIL_W = 220;      // left label rail width (collapsed: 48)
const DAY_W = 14;        // px per day (month view)

// ── Date utilities ────────────────────────────────────────────────────────────

function startOfDay(iso: string): Date {
  const d = new Date(iso);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function toDay(d: Date | string): number {
  const dt = typeof d === "string" ? startOfDay(d) : d;
  return Math.floor(dt.getTime() / 86_400_000);
}

function fmtShort(d: string | null): string {
  if (!d) return "—";
  return startOfDay(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function slipDays(current: string | null, baseline: string | null): number | null {
  if (!current || !baseline) return null;
  return toDay(current) - toDay(baseline);
}

function fmtSlip(days: number | null): string | null {
  if (days === null || days === 0) return null;
  return days > 0 ? `+${days}d` : `${days}d`;
}

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
    case "on_track":   return "text-success";
    case "at_risk":    return "text-warning";
    case "delayed":    return "text-danger";
    default:           return "text-ink-muted";
  }
}

// ── Diamond SVG ──────────────────────────────────────────────────────────────

function DiamondIcon({ className }: { className?: string }) {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor" className={className}>
      <path d="M5.5 0L11 5.5L5.5 11L0 5.5L5.5 0Z" />
    </svg>
  );
}

// ── PortfolioRoadmap ──────────────────────────────────────────────────────────

export function PortfolioRoadmap({ projects, milestones }: RoadmapProps) {
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);

  const railW = railCollapsed ? 48 : RAIL_W;

  // ── Date bounds ───────────────────────────────────────────────────────────

  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const todayDay = toDay(today);

  const { minDay, maxDay, totalDays } = useMemo(() => {
    const allDates: string[] = [];
    for (const p of projects) {
      if (p.start_date)  allDates.push(p.start_date);
      if (p.target_date) allDates.push(p.target_date);
    }
    for (const m of milestones) {
      if (m.target_date)          allDates.push(m.target_date);
      if (m.baseline_target_date) allDates.push(m.baseline_target_date);
    }
    if (allDates.length === 0) {
      return { minDay: todayDay - 30, maxDay: todayDay + 90, totalDays: 121 };
    }
    const days = allDates.map(toDay);
    const rawMin = Math.min(...days);
    const rawMax = Math.max(...days);
    const mn = rawMin - 14;
    const mx = rawMax + 28;
    return { minDay: mn, maxDay: mx, totalDays: mx - mn + 1 };
  }, [projects, milestones, todayDay]);

  const totalPx = totalDays * DAY_W;
  const todayOffset = (todayDay - minDay) * DAY_W;
  const todayVisible = todayDay >= minDay && todayDay <= maxDay;

  // ── Month gridline ticks ──────────────────────────────────────────────────

  const monthTicks = useMemo(() => {
    const result: { label: string; col: number }[] = [];
    let lastMonth = -1;
    const base = new Date(minDay * 86_400_000);
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      const month = d.getMonth();
      if (month !== lastMonth) {
        result.push({
          label: d.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
          col: i,
        });
        lastMonth = month;
      }
    }
    return result;
  }, [minDay, totalDays]);

  // ── Bar layout helper ─────────────────────────────────────────────────────

  function barLayout(start: string | null, end: string | null): { left: number; width: number } | null {
    if (!start && !end) return null;
    const s = start ? (toDay(start) - minDay) * DAY_W : null;
    const e = end   ? (toDay(end)   - minDay) * DAY_W + DAY_W : null;
    const left  = s ?? e!;
    const right = e ?? (s! + DAY_W);
    return { left, width: Math.max(right - left, DAY_W) };
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
      <div className="flex flex-col items-center gap-3 rounded-xl border border-border-subtle bg-surface py-20 text-center">
        <Calendar size={32} className="text-ink-muted opacity-30" />
        <p className="text-sm text-ink-secondary">No projects with dates yet.</p>
        <p className="text-xs text-ink-muted">Add start and target dates to your projects to see them here.</p>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-3">
      {/* Outer chart card */}
      <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface shadow-sm">
        <div className="flex" style={{ minWidth: 480 }}>

          {/* ── Left rail ──────────────────────────────────────────────────── */}
          <div
            className={cn(
              "shrink-0 sticky left-0 z-20 bg-surface border-r border-border-subtle flex flex-col transition-all duration-200",
            )}
            style={{ width: railW }}
          >
            {/* Rail header */}
            <div
              className="flex items-center justify-between border-b border-border-subtle bg-sunken/60 px-3"
              style={{ height: HEADER_H }}
            >
              {!railCollapsed && (
                <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted select-none">
                  Project
                </span>
              )}
              <button
                onClick={() => setRailCollapsed((v) => !v)}
                className="ml-auto rounded-md p-1 text-ink-muted hover:text-ink hover:bg-sunken transition-colors duration-150"
                title={railCollapsed ? "Expand rail" : "Collapse rail"}
              >
                {railCollapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
              </button>
            </div>

            {/* Project label rows */}
            {projects.map((project) => {
              const pct = Math.min(100, Math.max(0, project.completion_pct ?? 0));
              return (
                <div
                  key={project.id}
                  className="flex items-center gap-2 border-b border-border-subtle px-3 cursor-pointer hover:bg-sunken/60 transition-colors duration-100"
                  style={{ height: ROW_H }}
                  onClick={() => router.push(`/projects/${project.id}`)}
                  title={`${project.code} — ${project.name}`}
                >
                  {/* RAG dot */}
                  <span
                    className={cn("h-2 w-2 rounded-full shrink-0", ragDotClass(project.rag_status))}
                    title={ragLabel(project.rag_status)}
                  />
                  {!railCollapsed && (
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-mono text-2xs text-ink-muted shrink-0">
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
                        <span className="font-mono text-2xs text-ink-muted tabular-nums shrink-0">
                          {pct}%
                        </span>
                      </div>
                    </div>
                  )}
                </div>
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
                className="sticky top-0 z-10 bg-sunken/80 backdrop-blur-sm border-b border-border-subtle relative"
                style={{ height: HEADER_H, width: totalPx }}
              >
                {monthTicks.map((tick) => (
                  <div
                    key={`${tick.label}-${tick.col}`}
                    className="absolute top-0 bottom-0 flex items-center px-2 pointer-events-none"
                    style={{ left: tick.col * DAY_W }}
                  >
                    <div
                      className="absolute left-0 top-0 bottom-0 w-px bg-border-subtle"
                      style={{ opacity: 0.5 }}
                    />
                    <span className="text-[11px] font-semibold text-ink-secondary whitespace-nowrap select-none">
                      {tick.label}
                    </span>
                  </div>
                ))}
                {/* Today pill */}
                {todayVisible && (
                  <div
                    className="absolute top-1/2 -translate-y-1/2 pointer-events-none"
                    style={{ left: todayOffset }}
                  >
                    <div className="rounded-full bg-accent px-1.5 py-0.5">
                      <span className="text-2xs font-bold text-white whitespace-nowrap select-none">
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
                    style={{ left: tick.col * DAY_W, opacity: 0.4 }}
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

                  return (
                    <div
                      key={project.id}
                      className="relative border-b border-border-subtle cursor-pointer group"
                      style={{ height: ROW_H, width: totalPx }}
                      onClick={() => router.push(`/projects/${project.id}`)}
                      role="link"
                      aria-label={`Go to project ${project.name}`}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          router.push(`/projects/${project.id}`);
                        }
                      }}
                    >
                      {/* Hover tint */}
                      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 bg-sunken/40 transition-opacity duration-100 pointer-events-none" />

                      {/* Project span bar */}
                      {bar && (
                        <div
                          className={cn(
                            "absolute top-1/2 -translate-y-1/2 rounded-md h-6 overflow-hidden",
                            ragBarClass(project.rag_status),
                          )}
                          style={{ left: bar.left, width: bar.width }}
                          title={`${project.name} · ${fmtShort(project.start_date)} → ${fmtShort(project.target_date)}`}
                        >
                          {/* progress fill */}
                          <div
                            className={cn(
                              "h-full rounded-md transition-all duration-300",
                              ragProgressClass(project.rag_status),
                            )}
                            style={{ width: `${Math.min(project.completion_pct ?? 0, 100)}%` }}
                          />
                        </div>
                      )}

                      {/* Milestone diamonds */}
                      {pms.map((ms, idx) => {
                        if (!ms.target_date) return null;
                        const left = (toDay(ms.target_date) - minDay) * DAY_W + DAY_W / 2;
                        const slip = slipDays(ms.target_date, ms.baseline_target_date);
                        const slipLabel = fmtSlip(slip);
                        const hasSlip = slip !== null && slip > 0;

                        // baseline ghost diamond
                        const baselineLeft = ms.baseline_target_date
                          ? (toDay(ms.baseline_target_date) - minDay) * DAY_W + DAY_W / 2
                          : null;

                        const tooltipText = [
                          ms.name,
                          `Target: ${fmtShort(ms.target_date)}`,
                          ms.baseline_target_date
                            ? `Baseline: ${fmtShort(ms.baseline_target_date)}`
                            : null,
                          slipLabel ? `Slip: ${slipLabel}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ");

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
                            <div
                              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 flex items-center"
                              style={{ left }}
                              title={tooltipText}
                            >
                              <DiamondIcon
                                className={cn("w-3.5 h-3.5", milestoneColor(ms.status))}
                              />
                              {hasSlip && slipLabel && (
                                <span className="ml-0.5 font-mono text-2xs font-semibold text-warning select-none whitespace-nowrap pointer-events-none">
                                  {slipLabel}
                                </span>
                              )}
                            </div>
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

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-1">
        {/* RAG colours */}
        {[
          { label: "On track",    bg: "bg-success/50" },
          { label: "At risk",     bg: "bg-warning/50" },
          { label: "Delayed",     bg: "bg-danger/50" },
          { label: "Complete",    bg: "bg-accent/50" },
          { label: "Not started", bg: "bg-info/30" },
        ].map(({ label, bg }) => (
          <div key={label} className="flex items-center gap-1.5">
            <span className={cn("h-2 w-4 rounded-sm", bg)} />
            <span className="text-[11px] text-ink-muted">{label}</span>
          </div>
        ))}

        {/* Milestone marker */}
        <div className="flex items-center gap-1.5">
          <DiamondIcon className="text-ink-secondary w-3 h-3" />
          <span className="text-[11px] text-ink-muted">Milestone</span>
        </div>

        {/* Baseline slip */}
        {milestones.some((m) => m.baseline_target_date) && (
          <>
            <div className="flex items-center gap-1.5">
              <DiamondIcon className="text-ink-muted opacity-30 w-3 h-3" />
              <span className="text-[11px] text-ink-muted">Baseline</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-2xs font-semibold text-warning">+Nd</span>
              <span className="text-[11px] text-ink-muted">Slip vs baseline</span>
            </div>
          </>
        )}

        {/* Today */}
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-px bg-accent/70" />
          <span className="text-[11px] text-ink-muted">Today</span>
        </div>
      </div>
    </div>
  );
}

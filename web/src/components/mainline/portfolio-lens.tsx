"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ragLabel, ragTone } from "@/lib/status";
import { cn } from "@/lib/cn";
import { dateToX, laneIndexByProject } from "@/lib/mainline/layout";
import type { TLGraph, TLNode } from "@/lib/timeline/gather";
import { describeBar, fmtDate, toDay } from "@/lib/timeline";
import { TimelineBar } from "@/components/timeline/timeline-bar";
import { TimelineTable } from "@/components/timeline/timeline-table";
import { useDateDisplayPref } from "@/lib/theme/use-appearance";

const LANE_H = 56;
const PX_PER_DAY = 5;
const MIN_WIDTH = 720;
const LABEL_MAX_W = 90; // matches the label's max-w-[90px]
const LABEL_GAP = 6;
const CHAR_W = 6.4; // text-xs mono-ish average advance, used to estimate label width

/**
 * Collision-aware label visibility for one lane. Every node keeps its mark
 * (and a full aria-label/title); only labels that would overprint an
 * already-placed label are hidden. Milestones claim space first, then tasks.
 */
function visibleLabels(nodes: TLNode[], xs: number[]): boolean[] {
  const show = new Array<boolean>(nodes.length).fill(false);
  const placed: Array<[number, number]> = [];
  const order = nodes
    .map((n, i) => i)
    .sort((a, b) => Number(nodes[b].kind === "milestone") - Number(nodes[a].kind === "milestone") || a - b);
  for (const i of order) {
    const w = Math.min(LABEL_MAX_W, nodes[i].label.length * CHAR_W + 4);
    const l = xs[i] - w / 2;
    const r = xs[i] + w / 2;
    if (placed.every(([pl, pr]) => r + LABEL_GAP <= pl || l >= pr + LABEL_GAP)) {
      show[i] = true;
      placed.push([l, r]);
    }
  }
  return show;
}

function dayCount(startIso: string, endIso: string): number {
  return Math.max(toDay(endIso) - toDay(startIso), 1);
}

/**
 * Lens 1 — Subway (Portfolio): one lane per project, milestone + task nodes
 * plotted on a shared horizontal time axis. Read-only — every node is a
 * deep-link to its real page (EntityLink-style href already resolved by
 * gatherTimeline). SteerCo gates + Today render as workspace-wide gridlines
 * (they aren't scoped to a single project lane).
 */
export function PortfolioLens({ graph }: { graph: TLGraph }) {
  const pref = useDateDisplayPref();
  const laneNodes = useMemo(
    () => graph.nodes.filter((n): n is TLNode => n.kind === "milestone" || n.kind === "task"),
    [graph.nodes],
  );

  const lanes = useMemo(() => laneIndexByProject(graph.projects.map((p) => p.id)), [graph.projects]);

  const width = Math.max(MIN_WIDTH, dayCount(graph.axis.start, graph.axis.end) * PX_PER_DAY);
  const height = graph.projects.length * LANE_H;

  const byProject = useMemo(() => {
    const map = new Map<string, TLNode[]>();
    for (const n of laneNodes) {
      if (!n.projectId) continue;
      if (!map.has(n.projectId)) map.set(n.projectId, []);
      map.get(n.projectId)!.push(n);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
    return map;
  }, [laneNodes]);

  const todayX = dateToX(graph.axis.today, graph.axis.start, graph.axis.end, width);
  const todayVisible = graph.axis.today >= graph.axis.start && graph.axis.today <= graph.axis.end;

  if (graph.projects.length === 0) {
    return (
      <EmptyState purpose="Nothing scheduled across the portfolio yet — add a project with milestones or tasks to see the Subway lens." canWrite={false} />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface shadow-sm">
        <div className="flex" style={{ minWidth: 280 + width }}>
          {/* Sticky project label column */}
          <div className="shrink-0 sticky left-0 z-20 w-52 sm:w-64 border-r border-border-subtle bg-surface">
            <div className="flex items-center border-b border-border-subtle bg-sunken/60 px-3" style={{ height: 40 }}>
              <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted select-none">
                Project
              </span>
            </div>
            {graph.projects.map((p) => (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className="flex items-center gap-2 border-b border-border-subtle px-3 hover:bg-sunken/40 transition-colors min-h-[44px]"
                style={{ height: LANE_H }}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: p.color }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">{p.code}</span>
                  <span className="block truncate text-xs text-ink-muted">{p.name}</span>
                </span>
                <Badge size="sm" tone={ragTone(p.ragStatus)} className="shrink-0">
                  {ragLabel(p.ragStatus)}
                </Badge>
              </Link>
            ))}
          </div>

          {/* Scrollable axis + lanes */}
          <div className="relative flex-1" style={{ width, minWidth: width }}>
            {/* Header: SteerCo gates */}
            <div className="relative border-b border-border-subtle bg-sunken/60" style={{ height: 40 }}>
              {graph.axis.steercoDates.map((d) => {
                const x = dateToX(d, graph.axis.start, graph.axis.end, width);
                return (
                  <div key={d} className="absolute top-0 bottom-0 flex items-center pointer-events-none" style={{ left: x }}>
                    <div className="absolute top-0 bottom-0 w-px bg-warning/40" />
                    <span className="ml-1 whitespace-nowrap text-xs font-medium text-warning">SteerCo</span>
                  </div>
                );
              })}
              {todayVisible && (
                <div className="absolute top-0 bottom-0 flex items-center pointer-events-none" style={{ left: todayX }}>
                  <div className="rounded-full bg-accent px-1.5 py-0.5">
                    <span className="text-xs font-bold text-accent-ink whitespace-nowrap select-none">Today</span>
                  </div>
                </div>
              )}
            </div>

            {/* Background gridlines (steerco + today), full height */}
            <div className="absolute inset-x-0 pointer-events-none" style={{ top: 40, bottom: 0 }}>
              {graph.axis.steercoDates.map((d) => (
                <div
                  key={d}
                  className="absolute top-0 bottom-0 w-px bg-warning/20"
                  style={{ left: dateToX(d, graph.axis.start, graph.axis.end, width) }}
                />
              ))}
              {todayVisible && (
                <div className="absolute top-0 bottom-0 w-px bg-accent/60" style={{ left: todayX }} />
              )}
            </div>

            {/* Lanes */}
            <div style={{ position: "relative", height }}>
              {graph.projects.map((p) => {
                const nodes = byProject.get(p.id) ?? [];
                const laneY = (lanes.get(p.id) ?? 0) * LANE_H;
                const nodeXs = nodes.map((n) => dateToX(n.date, graph.axis.start, graph.axis.end, width));
                const showLabel = visibleLabels(nodes, nodeXs);
                return (
                  <div
                    key={p.id}
                    className="absolute left-0 right-0 border-b border-border-subtle"
                    style={{ top: laneY, height: LANE_H }}
                  >
                    {nodes.map((n, i) => {
                      const x = dateToX(n.date, graph.axis.start, graph.axis.end, width);
                      const critical = n.onCriticalPath;
                      const isMilestone = n.kind === "milestone";
                      const mark = (
                        <>
                          <span
                            className={cn(
                              isMilestone ? "h-3 w-3 rotate-45 rounded-[2px]" : "h-2.5 w-2.5 rounded-full",
                              critical ? "ring-2 ring-danger" : "",
                            )}
                            style={{ background: critical ? "var(--color-danger)" : p.color }}
                          />
                          {showLabel[i] && (
                            <span className="max-w-[90px] truncate text-xs text-ink-muted select-none">
                              {n.label}
                            </span>
                          )}
                        </>
                      );
                      return (
                        <TimelineBar
                          key={n.id}
                          label={describeBar({
                            kind: isMilestone ? "Milestone" : "Task",
                            name: n.label,
                            start: isMilestone ? null : n.endDate,
                            end: n.date,
                            status: n.status,
                            critical,
                            pref,
                          })}
                          href={n.href ?? undefined}
                          className="absolute inset-y-0 flex flex-col items-center justify-center gap-0.5 rounded"
                          style={{ left: x - 22, width: 44 }}
                        >
                          {mark}
                        </TimelineBar>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Text alternative for the chart */}
      <TimelineTable
        caption="Portfolio timeline: milestones and tasks per project with dates, status and critical path"
        columns={["Item", "Type", "Project", "Dates", "Status", "Critical path"]}
        rows={graph.projects.flatMap((p) =>
          (byProject.get(p.id) ?? []).map((n) => [
            n.label,
            n.kind === "milestone" ? "Milestone" : "Task",
            `${p.code} ${p.name}`,
            n.kind === "task" && n.endDate ? `${fmtDate(n.endDate, pref)} to ${fmtDate(n.date, pref)}` : fmtDate(n.date, pref),
            n.status ?? "-",
            n.onCriticalPath ? "yes" : "no",
          ]),
        )}
      />

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-1">
        <div className="flex items-center gap-1.5">
          <span className="h-3 w-3 rotate-45 rounded-[2px] bg-ink-muted/60" />
          <span className="text-xs text-ink-muted">Milestone</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-ink-muted/60" />
          <span className="text-xs text-ink-muted">Task</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full ring-2 ring-danger" style={{ background: "var(--color-danger)" }} />
          <span className="text-xs text-ink-muted">Critical-path project</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-px bg-accent/60" style={{ display: "inline-block" }} />
          <span className="text-xs text-ink-muted">Today</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-px bg-warning/40" style={{ display: "inline-block" }} />
          <span className="text-xs text-ink-muted">SteerCo gate</span>
        </div>
      </div>
    </div>
  );
}

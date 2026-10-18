"use client";

import Link from "next/link";
import { useMemo } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/cn";
import { packDagPositions, capLabels } from "@/lib/mainline/layout";
import { calculateCriticalPath, toCpmMap, type CpmInputDep, type CpmInputTask } from "@/lib/schedule/cpm";
import type { TLGraph } from "@/lib/timeline/gather";
import { TimelineTable } from "@/components/timeline/timeline-table";

export interface DependencyEdgeRow {
  id: string;
  /** Derived from the tasks at both ends (the table has no such column);
   *  null for an edge that spans projects or has an unknown end. */
  project_id: string | null;
  predecessor_id: string;
  successor_id: string;
  type: "FS" | "SS" | "FF" | "SF";
  lag_days: number;
}

const NODE_R = 5;
const LABEL_CAP = 60; // perf guard — see lib/mainline/layout.ts capLabels

function lagLabel(days: number): string {
  if (!days) return "";
  return days > 0 ? ` +${days}d` : ` ${days}d`;
}

/**
 * Lens 3 — Network (Dependency): the cross-project task dependency graph
 * (`task_dependencies` rows, typed + lag) rendered as a layered DAG (inline
 * SVG, no new chart dep — same idiom as gantt.tsx's arrow overlay).
 * Critical-path edges/nodes are tokenized in the danger accent; every other
 * edge is a subtle border-strong line. Per-project CPM is run independently
 * (task_dependencies never cross a project boundary at write time — see
 * api/tasks/[id]/dependencies/route.ts) and the critical flags are unioned
 * across projects for this one workspace-wide view.
 */
export function DependencyLens({ graph, dependencies }: { graph: TLGraph; dependencies: DependencyEdgeRow[] }) {
  const taskById = useMemo(() => {
    const m = new Map<string, { label: string; projectId: string | null; href: string | null }>();
    for (const n of graph.nodes) {
      if (n.kind === "task") m.set(n.id, { label: n.label, projectId: n.projectId, href: n.href });
    }
    return m;
  }, [graph.nodes]);

  const projectColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of graph.projects) m.set(p.id, p.color);
    return m;
  }, [graph.projects]);

  // Only render tasks that actually participate in an edge (perf guard —
  // the DAG is meaningless for isolated tasks and this keeps node count
  // proportional to dependency count, not total task count).
  const nodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of dependencies) {
      if (taskById.has(d.predecessor_id)) ids.add(d.predecessor_id);
      if (taskById.has(d.successor_id)) ids.add(d.successor_id);
    }
    return Array.from(ids);
  }, [dependencies, taskById]);

  // Per-project CPM, unioned into one criticality set.
  const criticalIds = useMemo(() => {
    const byProject = new Map<string, CpmInputDep[]>();
    for (const d of dependencies) {
      // an edge with no single owning project still draws; it just can't
      // take part in a per-project critical-path pass
      if (!d.project_id) continue;
      if (!byProject.has(d.project_id)) byProject.set(d.project_id, []);
      byProject.get(d.project_id)!.push({
        predecessor_id: d.predecessor_id,
        successor_id: d.successor_id,
        type: d.type,
        lag_days: d.lag_days ?? 0,
      });
    }
    const critical = new Set<string>();
    for (const [projectId, deps] of byProject) {
      const taskRows: CpmInputTask[] = graph.nodes
        .filter((n) => n.kind === "task" && n.projectId === projectId)
        .map((n) => ({ id: n.id, start_date: n.endDate, due_date: n.date }));
      const cpm = toCpmMap(calculateCriticalPath(taskRows, deps));
      for (const [id, r] of cpm) if (r.isCritical) critical.add(id);
    }
    return critical;
  }, [dependencies, graph.nodes]);

  const positions = useMemo(() => packDagPositions(nodeIds, dependencies.map((d) => ({ from: d.predecessor_id, to: d.successor_id }))), [nodeIds, dependencies]);

  const showLabel = useMemo(() => {
    const flags = capLabels(nodeIds.length, LABEL_CAP);
    return new Map(nodeIds.map((id, i) => [id, flags[i]]));
  }, [nodeIds]);

  if (dependencies.length === 0 || nodeIds.length === 0) {
    return (
      <EmptyState purpose="No task dependencies recorded yet — add a dependency between two tasks in a project to see the Network lens." canWrite={false} />
    );
  }

  const colW = 200;
  const rowH = 48;
  const maxLevel = Math.max(0, ...Array.from(positions.values()).map((p) => p.level));
  const levelCounts = new Map<number, number>();
  for (const p of positions.values()) levelCounts.set(p.level, (levelCounts.get(p.level) ?? 0) + 1);
  const maxRows = Math.max(1, ...Array.from(levelCounts.values()));

  const width = (maxLevel + 1) * colW + 80;
  const height = maxRows * rowH + 80;
  const originY = height / 2;

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-auto rounded-lg border border-border-subtle bg-surface p-4">
        <svg width={width} height={height} style={{ minWidth: width }} role="img" aria-label="Task dependency network. A table of the same edges follows for screen readers.">
          <defs>
            <marker id="mainline-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="var(--color-border-strong)" opacity="0.6" />
            </marker>
            <marker id="mainline-arrow-critical" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="var(--color-danger)" opacity="0.9" />
            </marker>
          </defs>

          {dependencies.map((d) => {
            const from = positions.get(d.predecessor_id);
            const to = positions.get(d.successor_id);
            if (!from || !to) return null;
            const critical = criticalIds.has(d.predecessor_id) && criticalIds.has(d.successor_id);
            const x1 = from.x + 40 + NODE_R;
            const y1 = originY + from.y;
            const x2 = to.x + 40 - NODE_R;
            const y2 = originY + to.y;
            const midX = x1 + Math.max((x2 - x1) / 2, 16);
            const path = `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;
            return (
              <path
                key={d.id}
                d={path}
                stroke={critical ? "var(--color-danger)" : "var(--color-border-strong)"}
                strokeOpacity={critical ? 0.9 : 0.45}
                strokeWidth={critical ? 2 : 1.25}
                fill="none"
                markerEnd={critical ? "url(#mainline-arrow-critical)" : "url(#mainline-arrow)"}
              >
                <title>
                  {`${d.type}${lagLabel(d.lag_days)}`}
                </title>
              </path>
            );
          })}

          {nodeIds.map((id) => {
            const pos = positions.get(id);
            const task = taskById.get(id);
            if (!pos || !task) return null;
            const x = pos.x + 40;
            const y = originY + pos.y;
            const critical = criticalIds.has(id);
            const color = critical ? "var(--color-danger)" : task.projectId ? (projectColor.get(task.projectId) ?? "var(--color-border-strong)") : "var(--color-border-strong)";
            return (
              <g key={id}>
                <circle cx={x} cy={y} r={NODE_R} fill={color} className={critical ? "" : undefined}>
                  <title>{`${task.label}${critical ? " · Critical path" : ""}`}</title>
                </circle>
                {showLabel.get(id) && (
                  <text x={x + NODE_R + 4} y={y + 3} className="fill-current text-ink-secondary" fontSize={12}>
                    {task.label.length > 22 ? `${task.label.slice(0, 22)}…` : task.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Node → detail links (SVG isn't natively focusable/clickable per-row in older Safari;
          this list gives a keyboard/touch-friendly, R-63-sized way into every task shown). */}
      <div className="flex flex-wrap gap-1.5">
        {nodeIds.map((id) => {
          const task = taskById.get(id);
          if (!task?.href) return null;
          const critical = criticalIds.has(id);
          return (
            <Link
              key={id}
              href={task.href}
              className={cn(
                "focus-ring inline-flex min-h-[44px] sm:min-h-[28px] items-center rounded-full border px-2.5 text-xs transition-colors",
                critical
                  ? "border-danger/40 bg-danger/10 text-danger-ink hover:bg-danger/15"
                  : "border-border-subtle bg-well text-ink-secondary hover:text-ink",
              )}
            >
              {task.label}
              {critical && <span className="ml-1 font-semibold">(critical path)</span>}
            </Link>
          );
        })}
      </div>

      <TimelineTable
        caption="Task dependencies: predecessor, successor, type, lag and critical path"
        columns={["Predecessor", "Successor", "Type", "Lag", "Critical path"]}
        rows={dependencies.map((d) => [
          taskById.get(d.predecessor_id)?.label ?? d.predecessor_id,
          taskById.get(d.successor_id)?.label ?? d.successor_id,
          d.type,
          `${d.lag_days ?? 0}d`,
          criticalIds.has(d.predecessor_id) && criticalIds.has(d.successor_id) ? "yes" : "no",
        ])}
      />

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-1">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-0 w-4 rounded-full" style={{ borderTop: "2px solid var(--color-danger)", opacity: 0.9 }} />
          <span className="text-xs text-ink-muted">Critical path</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-0 w-4 rounded-full" style={{ borderTop: "1.25px solid var(--color-border-strong)", opacity: 0.45 }} />
          <span className="text-xs text-ink-muted">Dependency (hover for type + lag)</span>
        </div>
      </div>
    </div>
  );
}

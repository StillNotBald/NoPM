"use client";

import { Badge } from "@/components/ui/badge";
import { DataList, type DataListColumn } from "@/components/ui/data-list";
import { useInspector } from "@/components/layout/app-shell";
import { ProjectDossier, type DossierProject } from "./project-dossier";
import { ragLabel, ragTone } from "@/lib/status";

export interface DashboardCardRow extends DossierProject {
  openR: number;
  openI: number;
  /** Target date already formatted for the viewer's date preference; null when unset. */
  targetText: string | null;
  targetTitle: string | null;
  isOverdue: boolean;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Phone (<md) view of the dashboard portfolio table. The 8-column table is
 * 1045px wide, so on a 390px phone RAG, completion and target date (the three
 * things a manager scans for) sat off-screen. Each project is a card instead:
 * name as the title, RAG / open risks / open issues as chips, completion and
 * target underneath. Tapping a card opens the same status dossier the desktop
 * row opens.
 */
export function DashboardProjectCards({ rows }: { rows: DashboardCardRow[] }) {
  const inspector = useInspector();

  const columns: DataListColumn<DashboardCardRow>[] = [
    {
      key: "name",
      header: "Project",
      primary: true,
      cell: (r) => (
        <>
          <span className="mr-1.5 font-mono text-xs font-normal text-ink-muted">{r.code}</span>
          {r.name}
        </>
      ),
    },
    {
      key: "rag",
      header: "RAG",
      badge: true,
      cell: (r) => (
        <Badge size="sm" tone={ragTone(r.rag_status)}>
          {ragLabel(r.rag_status)}
        </Badge>
      ),
    },
    {
      key: "risks",
      header: "Risks",
      badge: true,
      cell: (r) =>
        r.openR > 0 ? (
          <Badge size="sm" tone="danger" className="tabular-nums">
            {plural(r.openR, "open risk")}
          </Badge>
        ) : null,
    },
    {
      key: "issues",
      header: "Issues",
      badge: true,
      cell: (r) =>
        r.openI > 0 ? (
          <Badge size="sm" tone="warning" className="tabular-nums">
            {plural(r.openI, "open issue")}
          </Badge>
        ) : null,
    },
    {
      key: "completion",
      header: "Completion",
      cell: (r) => <span className="tabular-nums">{Math.round(r.completion_pct ?? 0)}%</span>,
    },
    {
      key: "target",
      header: "Target",
      cell: (r) =>
        r.targetText ? (
          <span title={r.targetTitle ?? undefined} className={r.isOverdue ? "font-medium text-danger-ink" : undefined}>
            <span className="font-mono tabular-nums">{r.targetText}</span>
            {r.isOverdue && " · overdue"}
          </span>
        ) : (
          "—"
        ),
    },
  ];

  return (
    <DataList
      className="md:hidden"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      onRowClick={(r) =>
        inspector.open(<ProjectDossier project={r} openR={r.openR} openI={r.openI} />, `${r.code} · status`)
      }
    />
  );
}

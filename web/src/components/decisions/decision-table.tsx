"use client";

import { useInspector } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { EntityLink } from "@/components/ui/entity-link";
import { EmptyState } from "@/components/ui/empty-state";
import { DataList, type DataListColumn } from "@/components/ui/data-list";
import { DecisionDetail } from "@/components/decisions/decision-detail";
import { NewDecisionButton } from "@/components/decisions/new-decision-button";
import type { Decision } from "@/components/decisions/decision-form";
import type { Tone } from "@/lib/status";

// ── Local helpers ─────────────────────────────────────────────────────────────

type DecisionStatus = Decision["status"];

function statusTone(s: DecisionStatus): Tone {
  if (s === "accepted") return "success";
  if (s === "rejected") return "danger";
  if (s === "superseded") return "warning";
  return "info"; // proposed
}

function statusLabel(s: DecisionStatus): string {
  const labels: Record<DecisionStatus, string> = {
    proposed: "Proposed",
    accepted: "Accepted",
    superseded: "Superseded",
    rejected: "Rejected",
  };
  return labels[s] ?? s;
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// ── DecisionTable ─────────────────────────────────────────────────────────────

interface DecisionTableProps {
  rows: Decision[];
  projectMap: Record<string, string>;
  refMap: Record<string, string>; // decision id → reference_id (for supersedes display)
  projects: Array<{ id: string; name: string }>;
  /** B1: change request id → "CR-004 Title", for the link in the detail. */
  changeLabelMap?: Record<string, string>;
  /** false for viewer-role callers — see risks/page.tsx (L-46). */
  canWrite?: boolean;
}

export function DecisionTable({ rows, projectMap, refMap, projects, changeLabelMap, canWrite = true }: DecisionTableProps) {
  const inspector = useInspector();

  if (rows.length === 0) {
    return (
      <EmptyState
        purpose="The decision log records what was decided, the options considered and why."
        canWrite={canWrite}
        action={<NewDecisionButton projects={projects} />}
        docsHref="/trust"
        docsLabel="See governance in the Trust Center"
      />
    );
  }

  function openDecision(d: Decision) {
    inspector.open(
      <DecisionDetail
        decision={d}
        changeRequestLabel={d.change_request_id ? (changeLabelMap?.[d.change_request_id] ?? null) : null}
        projectName={d.project_id ? (projectMap[d.project_id] ?? undefined) : undefined}
        supersededByRef={d.supersedes ? (refMap[d.supersedes] ?? null) : null}
        projects={projects}
      />,
      d.reference_id ? `Decision ${d.reference_id}` : "Decision",
    );
  }

  // Column order mirrors the ≥md table exactly; Ref/Project/Decision are
  // dropped from the <md card derivation only (hideOnMobile) so the two
  // card secondary fields land on Decided By + Date — the pair a reader
  // scans a decision log for at a glance.
  const columns: DataListColumn<Decision>[] = [
    {
      key: "ref",
      header: "Ref",
      hideOnMobile: true,
      cell: (d) =>
        d.reference_id ? (
          <span className="font-mono text-xs bg-well border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted">
            {d.reference_id}
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: "title",
      header: "Title",
      primary: true,
      cell: (d) => (
        <span className="block min-w-0 max-w-[180px] truncate font-medium text-ink">{d.title}</span>
      ),
    },
    {
      key: "project",
      header: "Project",
      hideOnMobile: true,
      cell: (d) =>
        d.project_id ? (
          <span className="block min-w-0 max-w-[140px]">
            <EntityLink kind="project" id={d.project_id} muted>
              <span className="truncate">{projectMap[d.project_id] ?? d.project_id.slice(0, 8) + "…"}</span>
            </EntityLink>
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: "decision",
      header: "Decision",
      hideOnMobile: true,
      cell: (d) => (
        <span className="block min-w-0 max-w-[180px] truncate text-ink-secondary">
          {d.decision ?? "—"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      badge: true,
      cell: (d) => (
        <Badge size="sm" tone={statusTone(d.status)}>
          {statusLabel(d.status)}
        </Badge>
      ),
    },
    {
      key: "decided_by",
      header: "Decided By",
      cell: (d) => <span className="text-ink-secondary">{d.decided_by_label ?? "—"}</span>,
    },
    {
      key: "date",
      header: "Date",
      cell: (d) => (
        <span className="text-ink-secondary tabular-nums">{formatDate(d.decided_at)}</span>
      ),
    },
  ];

  return (
    <DataList
      columns={columns}
      rows={rows}
      rowKey={(d) => d.id}
      onRowClick={openDecision}
      tableClassName="min-w-[760px]"
    />
  );
}

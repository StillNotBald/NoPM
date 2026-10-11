"use client";

import { useInspector } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { EntityLink } from "@/components/ui/entity-link";
import { EmptyState } from "@/components/ui/empty-state";
import { DataList, type DataListColumn } from "@/components/ui/data-list";
import { ChangeDetail } from "@/components/change-control/change-detail";
import { NewChangeButton } from "@/components/change-control/new-change-button";
import type { ChangeRequest } from "@/components/change-control/change-form";
import type { Tone } from "@/lib/status";

// ── Local helpers ─────────────────────────────────────────────────────────────

type CRStatus = ChangeRequest["status"];
type CRPriority = ChangeRequest["priority"];
type CRCategory = ChangeRequest["category"];

function statusTone(s: CRStatus): Tone {
  if (s === "approved" || s === "implemented") return "success";
  if (s === "rejected") return "danger";
  if (s === "deferred") return "warning";
  if (s === "under_review") return "info";
  return "neutral";
}

function statusLabel(s: CRStatus): string {
  const labels: Record<CRStatus, string> = {
    raised: "Raised",
    under_review: "Under Review",
    approved: "Approved",
    rejected: "Rejected",
    deferred: "Deferred",
    implemented: "Implemented",
  };
  return labels[s] ?? s;
}

function priorityTone(p: CRPriority): Tone {
  if (p === "critical") return "danger";
  if (p === "high") return "warning";
  if (p === "medium") return "info";
  return "neutral";
}

const CATEGORY_LABELS: Record<CRCategory, string> = {
  scope: "Scope",
  schedule: "Schedule",
  cost: "Cost",
  quality: "Quality",
  resource: "Resource",
  other: "Other",
};

// ── ChangeTable ───────────────────────────────────────────────────────────────

interface ChangeTableProps {
  rows: ChangeRequest[];
  projectMap: Record<string, string>;
  projects: Array<{ id: string; name: string }>;
  /** false for viewer-role callers — see risks/page.tsx (L-46). */
  canWrite?: boolean;
}

export function ChangeTable({ rows, projectMap, projects, canWrite = true }: ChangeTableProps) {
  const inspector = useInspector();

  if (rows.length === 0) {
    return (
      <EmptyState
        purpose="Change control captures anything that would move scope, schedule, or cost outside the agreed plan — with an explicit approve/reject decision and rationale."
        canWrite={canWrite}
        action={<NewChangeButton projects={projects} />}
        docsHref="/trust"
        docsLabel="See governance in the Trust Center"
      />
    );
  }

  function openChange(cr: ChangeRequest) {
    inspector.open(
      <ChangeDetail
        cr={cr}
        projectName={cr.project_id ? (projectMap[cr.project_id] ?? undefined) : undefined}
        projects={projects}
      />,
      cr.reference_id ? `CR ${cr.reference_id}` : "Change Request",
    );
  }

  // Column order mirrors the ≥md table exactly; Ref/Project/Category are
  // dropped from the <md card derivation only (hideOnMobile) so the two
  // card secondary fields land on Impact + Requested By.
  const columns: DataListColumn<ChangeRequest>[] = [
    {
      key: "ref",
      header: "Ref",
      hideOnMobile: true,
      cell: (cr) =>
        cr.reference_id ? (
          <span className="font-mono text-xs bg-sunken border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted">
            {cr.reference_id}
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: "title",
      header: "Title",
      primary: true,
      cell: (cr) => (
        <span className="block min-w-0 max-w-[200px] truncate font-medium text-ink">{cr.title}</span>
      ),
    },
    {
      key: "project",
      header: "Project",
      hideOnMobile: true,
      cell: (cr) =>
        cr.project_id ? (
          <span className="block min-w-0 max-w-[140px]">
            <EntityLink kind="project" id={cr.project_id} muted>
              <span className="truncate">{projectMap[cr.project_id] ?? cr.project_id.slice(0, 8) + "…"}</span>
            </EntityLink>
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: "category",
      header: "Category",
      hideOnMobile: true,
      cell: (cr) => (
        <span className="text-ink-secondary">{CATEGORY_LABELS[cr.category] ?? cr.category}</span>
      ),
    },
    {
      key: "priority",
      header: "Priority",
      badge: true,
      cell: (cr) => (
        <Badge size="sm" tone={priorityTone(cr.priority)}>
          {cr.priority}
        </Badge>
      ),
    },
    {
      key: "status",
      header: "Status",
      badge: true,
      cell: (cr) => (
        <Badge size="sm" tone={statusTone(cr.status)}>
          {statusLabel(cr.status)}
        </Badge>
      ),
    },
    {
      key: "impact",
      header: "Impact",
      cell: (cr) => (
        <span className="block min-w-0 max-w-[160px] truncate text-ink-secondary">
          {cr.impact_summary ?? "—"}
        </span>
      ),
    },
    {
      key: "requested_by",
      header: "Requested By",
      cell: (cr) => <span className="text-ink-secondary">{cr.requested_by_label ?? "—"}</span>,
    },
  ];

  return (
    <DataList
      columns={columns}
      rows={rows}
      rowKey={(cr) => cr.id}
      onRowClick={openChange}
      tableClassName="min-w-[820px]"
    />
  );
}

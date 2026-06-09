"use client";

import { Badge } from "@/components/ui/badge";
import { EntityLink } from "@/components/ui/entity-link";
import { ChangeRowButton, type ChangeDetailProps } from "@/components/change-control/change-detail";
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
}

export function ChangeTable({ rows, projectMap, projects }: ChangeTableProps) {
  if (rows.length === 0) {
    return (
      <div className="px-5 py-16 text-center">
        <p className="text-sm text-ink-muted">No change requests recorded yet.</p>
        <p className="mt-1 text-xs text-ink-muted">
          Use &ldquo;Raise Change Request&rdquo; to log the first one.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className="border-b border-border-subtle">
            <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide whitespace-nowrap">
              Ref
            </th>
            <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
              Title
            </th>
            <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
              Project
            </th>
            <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide whitespace-nowrap">
              Category
            </th>
            <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide whitespace-nowrap">
              Priority
            </th>
            <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide whitespace-nowrap">
              Status
            </th>
            <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
              Impact
            </th>
            <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide whitespace-nowrap">
              Requested By
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {rows.map((cr) => (
            <ChangeRowButton
              key={cr.id}
              cr={cr}
              projectName={cr.project_id ? (projectMap[cr.project_id] ?? undefined) : undefined}
              projects={projects}
            >
              <td className="px-5 py-3.5 whitespace-nowrap">
                {cr.reference_id ? (
                  <span className="font-mono text-xs bg-sunken border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted">
                    {cr.reference_id}
                  </span>
                ) : (
                  <span className="text-ink-muted">—</span>
                )}
              </td>
              <td className="px-5 py-3.5 min-w-0 max-w-[200px]">
                <span className="block truncate font-medium text-ink">{cr.title}</span>
              </td>
              <td className="px-5 py-3.5 min-w-0 max-w-[140px]">
                {cr.project_id ? (
                  <EntityLink kind="project" id={cr.project_id} muted>
                    <span className="truncate">{projectMap[cr.project_id] ?? cr.project_id.slice(0, 8) + "…"}</span>
                  </EntityLink>
                ) : (
                  <span className="text-ink-muted">—</span>
                )}
              </td>
              <td className="px-5 py-3.5 text-ink-secondary whitespace-nowrap">
                {CATEGORY_LABELS[cr.category] ?? cr.category}
              </td>
              <td className="px-5 py-3.5 whitespace-nowrap">
                <Badge size="sm" tone={priorityTone(cr.priority)}>{cr.priority}</Badge>
              </td>
              <td className="px-5 py-3.5 whitespace-nowrap">
                <Badge size="sm" tone={statusTone(cr.status)}>{statusLabel(cr.status)}</Badge>
              </td>
              <td className="px-5 py-3.5 min-w-0 max-w-[160px]">
                <span className="block truncate text-ink-secondary">{cr.impact_summary ?? "—"}</span>
              </td>
              <td className="px-5 py-3.5 text-ink-secondary whitespace-nowrap">
                {cr.requested_by_label ?? "—"}
              </td>
            </ChangeRowButton>
          ))}
        </tbody>
      </table>
    </div>
  );
}

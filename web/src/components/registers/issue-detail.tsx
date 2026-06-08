"use client";

import { useInspector } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { Button } from "@/components/ui/button";
import { IssueForm, type Issue, type IssueSeverity, type IssueCategory } from "@/components/forms/issue-form";

// ── Local type helpers ────────────────────────────────────────────────────────

type IssueStatus = "open" | "in_progress" | "resolved" | "closed";

function statusTone(s: IssueStatus) {
  if (s === "resolved" || s === "closed") return "success" as const;
  if (s === "in_progress") return "info" as const;
  if (s === "open") return "warning" as const;
  return "neutral" as const;
}

function statusLabel(s: IssueStatus) {
  if (s === "in_progress") return "In Progress";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const ISSUE_CATEGORY_LABELS: Record<IssueCategory, string> = {
  technical_defect: "Technical / System Defect",
  resource_unavailability: "Resource Unavailability",
  dependency_delay: "Dependency Delay",
  budget_funding: "Budget / Funding",
  scope_creep: "Scope Creep",
  stakeholder_conflict: "Stakeholder Conflict",
  operational_bottleneck: "Operational Bottleneck",
  data_quality: "Data Quality / Integrity",
  third_party_vendor: "Third-Party / Vendor",
  environmental_external: "Environmental / External",
};

function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// ── DetailRow ─────────────────────────────────────────────────────────────────

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 border-b border-border-subtle last:border-0">
      <span className="text-[10px] font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <div className="text-sm text-ink">{children}</div>
    </div>
  );
}

function TextValue({ value }: { value: string | null | undefined }) {
  if (!value || value.trim() === "") {
    return <span className="text-ink-muted">—</span>;
  }
  return <span className="whitespace-pre-wrap">{value}</span>;
}

// ── IssueDetail ───────────────────────────────────────────────────────────────

export interface IssueDetailProps {
  issue: Issue & {
    reference_id?: string | null;
  };
  projectName?: string;
}

export function IssueDetail({ issue, projectName }: IssueDetailProps) {
  const inspector = useInspector();

  function openEdit() {
    inspector.open(
      <IssueForm projectId={issue.project_id} issue={issue} />,
      "Edit Issue",
    );
  }

  return (
    <div className="flex flex-col gap-0 pb-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 pb-3 border-b border-border-subtle mb-1">
        <div className="flex-1 min-w-0">
          {issue.reference_id && (
            <span className="font-mono text-[11px] bg-sunken border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted mb-1 inline-block">
              {issue.reference_id}
            </span>
          )}
          <h2 className="text-base font-semibold text-ink leading-snug mt-0.5">
            {issue.title}
          </h2>
        </div>
        <Button variant="ghost" onClick={openEdit} className="shrink-0 h-9 px-3 text-xs">
          Edit
        </Button>
      </div>

      {/* Status / severity chips */}
      <div className="flex flex-wrap gap-2 py-2.5 border-b border-border-subtle">
        <Badge tone={statusTone(issue.status as IssueStatus)}>
          {statusLabel(issue.status as IssueStatus)}
        </Badge>
        <Severity level={issue.priority} />
        {issue.severity && (
          <span className="inline-flex items-center gap-1 text-xs text-ink-secondary">
            <span className="text-ink-muted">sev</span>
            <Severity level={issue.severity as IssueSeverity} />
          </span>
        )}
      </div>

      {/* Fields */}
      <div>
        <DetailRow label="Project">
          <TextValue value={projectName} />
        </DetailRow>

        <DetailRow label="Priority">
          <Severity level={issue.priority} />
        </DetailRow>

        <DetailRow label="Severity">
          {issue.severity ? (
            <Severity level={issue.severity as IssueSeverity} />
          ) : (
            <span className="text-ink-muted">—</span>
          )}
        </DetailRow>

        <DetailRow label="Category">
          <TextValue
            value={
              issue.issue_category
                ? (ISSUE_CATEGORY_LABELS[issue.issue_category] ?? issue.issue_category)
                : null
            }
          />
        </DetailRow>

        <DetailRow label="Due Date">
          <span className="tabular-nums">{formatDate(issue.due_date)}</span>
        </DetailRow>

        <DetailRow label="Resolution ETA">
          <span className="tabular-nums">{formatDate(issue.resolution_eta)}</span>
        </DetailRow>

        <DetailRow label="Resolved On">
          <span className="tabular-nums">{formatDate(issue.resolved_at)}</span>
        </DetailRow>

        {issue.description && issue.description.trim() !== "" && (
          <DetailRow label="Description">
            <TextValue value={issue.description} />
          </DetailRow>
        )}

        <DetailRow label="Impact">
          <TextValue value={issue.impact} />
        </DetailRow>

        {issue.resolution && issue.resolution.trim() !== "" && (
          <DetailRow label="Resolution / Action">
            <TextValue value={issue.resolution} />
          </DetailRow>
        )}
      </div>
    </div>
  );
}

// ── IssueRowButton — clickable <tr> wrapper (client component) ────────────────

export function IssueRowButton({
  issue,
  projectName,
  children,
}: IssueDetailProps & { children: React.ReactNode }) {
  const inspector = useInspector();

  function open() {
    inspector.open(
      <IssueDetail issue={issue} projectName={projectName} />,
      issue.reference_id ? `Issue ${issue.reference_id}` : "Issue Detail",
    );
  }

  return (
    <tr
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className="hover:bg-sunken transition-colors duration-100 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
    >
      {children}
    </tr>
  );
}

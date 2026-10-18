"use client";

import { RequestDeletionControl } from "@/components/governance/request-deletion";
import Link from "next/link";
import { History } from "lucide-react";
import { useInspector } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { Button } from "@/components/ui/button";
import { EntityLink } from "@/components/ui/entity-link";
import { DataList, type DataListColumn } from "@/components/ui/data-list";
import { formatByPref, type DateDisplayPref } from "@/lib/format/dates";
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
  if (s === "in_progress") return "In progress"; // same casing the register list uses
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const ISSUE_CATEGORY_LABELS: Record<IssueCategory, string> = {
  technical_fault: "Technical fault",
  resourcing: "Resourcing",
  schedule_delay: "Schedule delay",
  cost_overrun: "Cost / Funding",
  scope_change: "Scope change",
  organisational: "Organisational",
  supplier: "Supplier",
  external_event: "External event",
};

// ── DetailRow ─────────────────────────────────────────────────────────────────

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 border-b border-border-subtle last:border-0">
      <span className="text-2xs font-medium uppercase tracking-wide text-ink-muted">
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
  /** Same appearance preference the register list honours; absolute when omitted. */
  dateDisplayPref?: DateDisplayPref;
}

export function IssueDetail({ issue, projectName, dateDisplayPref = "absolute" }: IssueDetailProps) {
  const inspector = useInspector();
  const formatDate = (iso: string | null | undefined) => formatByPref(iso, dateDisplayPref).text;

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
            <span className="font-mono text-[11px] bg-well border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted mb-1 inline-block">
              {issue.reference_id}
            </span>
          )}
          <h2 className="text-base font-semibold text-ink leading-snug mt-0.5">
            {issue.title}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Link
            href={`/trust?target_type=issue&target_id=${issue.id}`}
            className="focus-ring inline-flex h-11 items-center gap-1 rounded-md px-2 text-xs text-ink-secondary hover:bg-well hover:text-ink sm:h-9"
          >
            <History size={13} />
            History
          </Link>
          <Button variant="ghost" onClick={openEdit} className="h-11 px-3 text-xs sm:h-9">
            Edit
          </Button>
        </div>
      </div>
      {/* G8: an issue is deleted by request; a different person approves it. */}
      <div className="flex flex-wrap items-center justify-end gap-2 py-2 border-b border-border-subtle">
        <RequestDeletionControl entity="issue" id={issue.id} name={issue.title} />
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

// ── IssueDataList — responsive register list (F5): table ≥md, cards <md ──────

type IssueRow = IssueDetailProps["issue"];

export function IssueDataList({
  issues,
  projectMap,
  dateDisplayPref,
}: {
  issues: IssueRow[];
  projectMap: Record<string, string>;
  dateDisplayPref: DateDisplayPref;
}) {
  const inspector = useInspector();

  function openIssue(issue: IssueRow) {
    inspector.open(
      <IssueDetail
        issue={issue}
        projectName={issue.project_id ? (projectMap[issue.project_id] ?? undefined) : undefined}
        dateDisplayPref={dateDisplayPref}
      />,
      issue.reference_id ? `Issue ${issue.reference_id}` : "Issue Detail",
    );
  }

  const columns: DataListColumn<IssueRow>[] = [
    {
      key: "ref",
      header: "Ref",
      hideOnMobile: true,
      cell: (i) =>
        i.reference_id ? (
          <span className="font-mono text-xs bg-well border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted whitespace-nowrap">
            {i.reference_id}
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: "title",
      header: "Title",
      primary: true,
      cell: (i) => (
        <span className="block min-w-0 max-w-[240px] truncate font-medium text-ink">{i.title}</span>
      ),
    },
    {
      key: "project",
      header: "Project",
      hideOnMobile: true,
      cell: (i) =>
        i.project_id ? (
          <span className="block min-w-0 max-w-[160px]">
            <EntityLink kind="project" id={i.project_id} muted>
              {projectMap[i.project_id] ?? "—"}
            </EntityLink>
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: "priority",
      header: "Priority",
      badge: true,
      cell: (i) => <Severity level={i.priority} />,
    },
    {
      key: "status",
      header: "Status",
      badge: true,
      cell: (i) => (
        <Badge size="sm" tone={statusTone(i.status as IssueStatus)}>
          {statusLabel(i.status as IssueStatus)}
        </Badge>
      ),
    },
    {
      key: "due",
      header: "Due",
      cell: (i) => {
        const due = formatByPref(i.due_date, dateDisplayPref);
        return (
          <span className="tabular-nums text-xs text-ink-secondary" title={due.title}>
            {due.text}
          </span>
        );
      },
    },
  ];

  return (
    <DataList
      columns={columns}
      rows={issues}
      rowKey={(i) => i.id}
      onRowClick={openIssue}
      tableClassName="min-w-[640px]"
    />
  );
}

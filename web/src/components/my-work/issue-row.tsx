"use client";

import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { EntityLink } from "@/components/ui/entity-link";
import { formatByPref } from "@/lib/format/dates";
import { useDateDisplayPref } from "@/lib/theme/use-appearance";

export interface MyIssue {
  id: string;
  title: string;
  priority: string;
  status: string;
  due_date: string | null;
  project_id: string;
  project_name: string | null;
  reference_id?: string | null;
}

function statusTone(s: string) {
  if (s === "resolved" || s === "closed") return "success" as const;
  if (s === "in_progress") return "info" as const;
  if (s === "open") return "warning" as const;
  return "neutral" as const;
}

function statusLabel(s: string) {
  if (s === "in_progress") return "In Progress";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function IssueRow({ issue }: { issue: MyIssue }) {
  const pref = useDateDisplayPref();
  const due = issue.due_date ? formatByPref(issue.due_date, pref) : null;
  return (
    <div className="flex flex-col gap-2 rounded-md px-3 py-2.5 text-sm transition-colors hover:bg-sunken sm:flex-row sm:items-center sm:gap-3 sm:py-2">
      <div className="flex min-h-11 min-w-0 items-center gap-3 sm:min-h-0">
        {/* Reference chip */}
        {issue.reference_id && (
          <span className="shrink-0 rounded border border-border-subtle bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
            {issue.reference_id}
          </span>
        )}

        {/* Title — deep-links into the issues register with focus param */}
        <EntityLink
          kind="issue"
          id={issue.id}
          className="min-w-0 flex-1 self-stretch font-medium"
        >
          {issue.title}
        </EntityLink>
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:contents">
        {/* Project chip */}
        {issue.project_name && (
          <span className="shrink-0 rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
            {issue.project_name}
          </span>
        )}

        {/* Priority */}
        <Severity level={issue.priority} className="shrink-0" />

        {/* Status */}
        <Badge size="sm" tone={statusTone(issue.status)} className="shrink-0">
          {statusLabel(issue.status)}
        </Badge>

        {/* Due date */}
        {issue.due_date && (
          <span
            title={due?.absolute}
            className="shrink-0 whitespace-nowrap font-mono text-xs tabular-nums text-ink-muted"
          >
            {due?.text}
          </span>
        )}
      </div>
    </div>
  );
}

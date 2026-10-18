"use client";

import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { EntityLink } from "@/components/ui/entity-link";
import { formatByPref } from "@/lib/format/dates";
import { useDateDisplayPref } from "@/lib/theme/use-appearance";

export interface MyRisk {
  id: string;
  title: string;
  severity: string;
  status: string;
  due_date: string | null;
  project_id: string;
  project_name: string | null;
  reference_id?: string | null;
}

function statusTone(s: string) {
  if (s === "closed" || s === "accepted") return "success" as const;
  if (s === "mitigating") return "warning" as const;
  if (s === "open") return "info" as const;
  return "neutral" as const;
}

export function RiskRow({ risk }: { risk: MyRisk }) {
  const pref = useDateDisplayPref();
  const due = risk.due_date ? formatByPref(risk.due_date, pref) : null;
  return (
    <div className="flex flex-col gap-2 rounded-md px-3 py-2.5 text-sm transition-colors hover:bg-well sm:flex-row sm:items-center sm:gap-3 sm:py-2">
      <div className="flex min-h-11 min-w-0 items-center gap-3 sm:min-h-0">
        {/* Reference chip */}
        {risk.reference_id && (
          <span className="shrink-0 rounded border border-border-subtle bg-well px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
            {risk.reference_id}
          </span>
        )}

        {/* Title — deep-links into the risks register with focus param */}
        <EntityLink
          kind="risk"
          id={risk.id}
          className="min-w-0 flex-1 self-stretch font-medium"
        >
          {risk.title}
        </EntityLink>
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:contents">
        {/* Project chip */}
        {risk.project_name && (
          <span className="shrink-0 rounded bg-well px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
            {risk.project_name}
          </span>
        )}

        {/* Severity */}
        <Severity level={risk.severity} className="shrink-0" />

        {/* Status */}
        <Badge size="sm" tone={statusTone(risk.status)} className="shrink-0">
          {risk.status}
        </Badge>

        {/* Due date */}
        {risk.due_date && (
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

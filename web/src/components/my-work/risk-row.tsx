"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";

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

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function RiskRow({ risk }: { risk: MyRisk }) {
  return (
    <Link
      href={`/risks`}
      className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors hover:bg-sunken"
    >
      {/* Reference chip */}
      {risk.reference_id && (
        <span className="shrink-0 rounded bg-sunken border border-border-subtle px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
          {risk.reference_id}
        </span>
      )}

      {/* Title */}
      <span className="min-w-0 flex-1 truncate font-medium text-ink">
        {risk.title}
      </span>

      {/* Project chip */}
      {risk.project_name && (
        <span className="shrink-0 rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
          {risk.project_name}
        </span>
      )}

      {/* Severity */}
      <Severity level={risk.severity} className="shrink-0" />

      {/* Status */}
      <Badge tone={statusTone(risk.status)} className="shrink-0">
        {risk.status}
      </Badge>

      {/* Due date */}
      {risk.due_date && (
        <span className="shrink-0 font-mono text-xs tabular-nums text-ink-muted">
          {formatDate(risk.due_date)}
        </span>
      )}
    </Link>
  );
}

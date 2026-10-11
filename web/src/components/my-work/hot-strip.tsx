"use client";

import Link from "next/link";
import { Severity } from "@/components/ui/severity";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { entityHref } from "@/lib/nav/entity-href";

export type HotItem =
  | {
      kind: "task";
      id: string;
      label: string;
      project_id: string;
      project_name: string | null;
      reason: "overdue";
      due_date: string;
    }
  | {
      kind: "risk";
      id: string;
      label: string;
      project_id: string;
      project_name: string | null;
      severity: string;
      reason: "high_risk";
    }
  | {
      kind: "issue";
      id: string;
      label: string;
      project_id: string;
      project_name: string | null;
      severity: string;
      reason: "high_issue";
    };

function kindTone(kind: HotItem["kind"]) {
  if (kind === "task") return "danger" as const;
  if (kind === "risk") return "warning" as const;
  return "info" as const;
}

function kindLabel(kind: HotItem["kind"]) {
  if (kind === "task") return "task";
  if (kind === "risk") return "risk";
  return "issue";
}

function hrefFor(item: HotItem) {
  if (item.kind === "task") return entityHref("task", { id: item.id, projectId: item.project_id });
  if (item.kind === "risk") return entityHref("risk", { id: item.id });
  return entityHref("issue", { id: item.id });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function HotStrip({ items }: { items: HotItem[] }) {
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-success/8 px-3 py-2.5 text-sm text-success">
        <span aria-hidden className="text-2xs">●</span>
        <span>Nothing hot right now — all clear.</span>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {items.map((item) => (
        <Link
          key={`${item.kind}-${item.id}`}
          href={hrefFor(item)}
          className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors hover:bg-sunken"
        >
          {/* Kind chip */}
          <Badge size="sm" tone={kindTone(item.kind)} className="shrink-0">
            {kindLabel(item.kind)}
          </Badge>

          {/* Label */}
          <span className="min-w-0 flex-1 truncate font-medium text-ink">
            {item.label}
          </span>

          {/* Project chip */}
          {item.project_name && (
            <span className="shrink-0 rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
              {item.project_name}
            </span>
          )}

          {/* Severity or overdue flag */}
          {item.kind === "task" && (
            <span className={cn("shrink-0 whitespace-nowrap rounded-full bg-danger/10 px-2 py-0.5 font-mono text-[11px] font-medium text-danger")}>
              overdue · {formatDate(item.due_date)}
            </span>
          )}
          {(item.kind === "risk" || item.kind === "issue") && (
            <Severity level={item.severity} className="shrink-0" />
          )}
        </Link>
      ))}
    </div>
  );
}

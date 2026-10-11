"use client";

import { DataList, type DataListColumn } from "@/components/ui/data-list";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

/**
 * Mobile pass (R-94, F5) — the Resources "Team Members" table as a
 * DataList: identical <table> at md+ (same 9 columns, same cell markup as
 * the table this replaced), card rows below md (name, role chip,
 * capacity/cost fields). A "use client" wrapper because DataList's column
 * `cell` functions are closures — those can't cross the server/client
 * boundary, so this component takes plain serializable row data from the
 * (server) page and builds the columns/renderCard here.
 */

export interface MemberListRow {
  id: string;
  name: string;
  roleTitle: string | null;
  costRateDisplay: string;
  capacityDisplay: string | null;
  allocatedDisplay: string | null;
  allocatedIsOver: boolean;
  freeDisplay: string | null;
  freeIsNegative: boolean;
  freeIsZero: boolean;
  openTasks: number;
  utilisationPct: number;
  barWidthPct: number;
}

export function MembersList({ rows }: { rows: MemberListRow[] }) {
  const columns: DataListColumn<MemberListRow>[] = [
    {
      key: "name",
      header: "Name",
      primary: true,
      cell: (r) => <span className="font-medium text-ink truncate block">{r.name}</span>,
    },
    {
      key: "role",
      header: "Role",
      cell: (r) =>
        r.roleTitle ? (
          <span className="truncate block">{r.roleTitle}</span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: "costRate",
      header: "Cost Rate / hr",
      align: "right",
      cell: (r) => <span className="font-mono tabular-nums text-ink-secondary">{r.costRateDisplay}</span>,
    },
    {
      key: "capacity",
      header: "Cap h/wk",
      align: "right",
      cell: (r) =>
        r.capacityDisplay ? (
          <span className="font-mono tabular-nums text-ink-secondary">{r.capacityDisplay}</span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: "allocated",
      header: "Alloc h/wk",
      align: "right",
      cell: (r) =>
        r.allocatedDisplay ? (
          <span
            className={cn("font-mono tabular-nums font-medium", r.allocatedIsOver ? "text-danger" : "text-ink")}
          >
            {r.allocatedDisplay}
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: "free",
      header: "Free h/wk",
      align: "right",
      cell: (r) =>
        r.freeDisplay ? (
          <span
            className={cn(
              "font-mono tabular-nums font-medium",
              r.freeIsNegative ? "text-danger" : r.freeIsZero ? "text-warning" : "text-success",
            )}
          >
            {r.freeIsNegative ? "" : "+"}
            {r.freeDisplay}
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: "openTasks",
      header: "Open Tasks",
      align: "right",
      cell: (r) =>
        r.openTasks > 0 ? (
          <span className="font-medium text-ink tabular-nums">{r.openTasks}</span>
        ) : (
          <span className="text-ink-muted tabular-nums">0</span>
        ),
    },
    {
      key: "utilisation",
      header: "Utilisation",
      align: "right",
      cell: (r) => (
        <div className="flex items-center justify-end gap-3">
          <div className="hidden h-1.5 w-20 overflow-hidden rounded-full bg-sunken sm:block">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                r.allocatedIsOver ? "bg-danger" : r.utilisationPct >= 80 ? "bg-warning" : "bg-accent",
              )}
              style={{ width: `${r.barWidthPct}%` }}
            />
          </div>
          <span
            className={cn(
              "font-mono tabular-nums font-medium",
              r.allocatedIsOver ? "text-danger" : r.utilisationPct >= 80 ? "text-warning" : "text-ink",
            )}
          >
            {r.utilisationPct.toFixed(0)}%
          </span>
        </div>
      ),
    },
    {
      key: "overBadge",
      header: "",
      cell: (r) => (r.allocatedIsOver ? <Badge tone="danger" size="sm">Over-allocated</Badge> : null),
    },
  ];

  return (
    <DataList
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      tableClassName="min-w-[760px]"
      renderCard={(r) => (
        <div className="flex min-h-[44px] flex-col gap-1.5 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-ink">{r.name}</span>
            {r.allocatedIsOver && (
              <Badge tone="danger" size="sm" className="shrink-0">
                Over
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {r.roleTitle ? (
              <Badge tone="neutral" size="sm">
                {r.roleTitle}
              </Badge>
            ) : (
              <span className="text-xs text-ink-muted">No role set</span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <div className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-ink-muted">Cost/hr</span>
              <span className="min-w-0 truncate font-mono tabular-nums text-ink-secondary">
                {r.costRateDisplay}
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-ink-muted">Cap h/wk</span>
              <span className="min-w-0 truncate font-mono tabular-nums text-ink-secondary">
                {r.capacityDisplay ?? "—"}
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-ink-muted">Alloc h/wk</span>
              <span
                className={cn(
                  "min-w-0 truncate font-mono tabular-nums font-medium",
                  r.allocatedIsOver ? "text-danger" : "text-ink",
                )}
              >
                {r.allocatedDisplay ?? "—"}
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-ink-muted">Open tasks</span>
              <span className="min-w-0 truncate font-mono tabular-nums text-ink-secondary">{r.openTasks}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-0.5">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  r.allocatedIsOver ? "bg-danger" : r.utilisationPct >= 80 ? "bg-warning" : "bg-accent",
                )}
                style={{ width: `${r.barWidthPct}%` }}
              />
            </div>
            <span
              className={cn(
                "shrink-0 font-mono text-xs tabular-nums font-medium",
                r.allocatedIsOver ? "text-danger" : r.utilisationPct >= 80 ? "text-warning" : "text-ink",
              )}
            >
              {r.utilisationPct.toFixed(0)}% util
            </span>
          </div>
        </div>
      )}
    />
  );
}

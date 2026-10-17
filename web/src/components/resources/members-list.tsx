"use client";

import { THead, TH, TR, TD } from "@/components/ui/data-table";
import { ScrollTable } from "@/components/registers/scroll-table";
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
  if (rows.length === 0) return null;
  const utilTone = (r: MemberListRow) =>
    r.allocatedIsOver ? "text-danger-ink" : r.utilisationPct >= 80 ? "text-warning-ink" : "text-ink";
  const dash = <span className="text-ink-muted">—</span>;

  return (
    <>
      {/* <md: cards */}
      <ul className="divide-y divide-border-subtle md:hidden print:hidden">
        {rows.map((r) => (
          <li key={r.id}>
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
                  r.allocatedIsOver ? "text-danger-ink" : "text-ink",
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
                r.allocatedIsOver ? "text-danger-ink" : r.utilisationPct >= 80 ? "text-warning-ink" : "text-ink",
              )}
            >
              {r.utilisationPct.toFixed(0)}% util
            </span>
          </div>
        </div>
          </li>
        ))}
      </ul>

      {/* >=md (and print): DataTable primitives */}
      <div className="hidden md:block print:block">
        <ScrollTable bare label="Team members" className="print:min-w-0">
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Role</TH>
              <TH align="right">Cost rate / hr</TH>
              <TH align="right">Cap h/wk</TH>
              <TH align="right">Alloc h/wk</TH>
              <TH align="right">Free h/wk</TH>
              <TH align="right">Open tasks</TH>
              <TH align="right">Utilisation</TH>
            </TR>
          </THead>
          <tbody>
            {rows.map((r) => (
              <TR key={r.id} className="hover:bg-sunken transition-colors duration-100 print:break-inside-avoid">
                <TD className="whitespace-nowrap font-medium">
                  {r.name}
                  {/* Stacked under the name (not a Status column of its own) so the badge costs no width. */}
                  {r.allocatedIsOver && (
                    <Badge tone="danger" size="sm" className="mt-0.5 flex w-fit">
                      Over-allocated
                    </Badge>
                  )}
                </TD>
                <TD className="text-ink-secondary">
                  {r.roleTitle ? (
                    <span className="block max-w-[10rem] truncate" title={r.roleTitle}>
                      {r.roleTitle}
                    </span>
                  ) : (
                    dash
                  )}
                </TD>
                <TD align="right" numeric className="whitespace-nowrap text-ink-secondary">{r.costRateDisplay}</TD>
                <TD align="right" numeric className="whitespace-nowrap text-ink-secondary">{r.capacityDisplay ?? dash}</TD>
                <TD
                  align="right"
                  numeric
                  className={cn("whitespace-nowrap font-medium", r.allocatedIsOver && "text-danger-ink")}
                >
                  {r.allocatedDisplay ?? dash}
                </TD>
                <TD
                  align="right"
                  numeric
                  className={cn(
                    "whitespace-nowrap font-medium",
                    r.freeIsNegative ? "text-danger-ink" : r.freeIsZero ? "text-warning-ink" : "text-success-ink",
                  )}
                >
                  {r.freeDisplay ? `${r.freeIsNegative ? "" : "+"}${r.freeDisplay}` : dash}
                </TD>
                <TD
                  align="right"
                  numeric
                  className={cn("whitespace-nowrap", r.openTasks > 0 ? "font-medium" : "text-ink-muted")}
                >
                  {r.openTasks}
                </TD>
                <TD align="right" className="whitespace-nowrap">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-1.5 w-14 overflow-hidden rounded-full bg-sunken print:border print:border-border-subtle">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          r.allocatedIsOver ? "bg-danger" : r.utilisationPct >= 80 ? "bg-warning" : "bg-accent",
                        )}
                        style={{ width: `${r.barWidthPct}%` }}
                      />
                    </div>
                    <span className={cn("w-10 text-right font-mono tabular-nums font-medium", utilTone(r))}>
                      {r.utilisationPct.toFixed(0)}%
                    </span>
                  </div>
                </TD>
              </TR>
            ))}
          </tbody>
        </ScrollTable>
      </div>
    </>
  );
}

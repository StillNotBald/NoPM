"use client";

import { DataList, type DataListColumn } from "@/components/ui/data-list";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

/**
 * Mobile pass (R-94, F5) — the two register-style tables on /budget (Earned
 * Value per project, and Planned/Committed/Actual) as DataList: identical
 * `<table>` at md+ (same columns/markup as before), card rows below md. A
 * "use client" wrapper because DataList's column `cell` closures can't
 * cross the server/client boundary — the (server) page pre-formats every
 * display string/tone here and passes plain data down.
 */

// ── Earned Value (EVM) per-project table ────────────────────────────────────

export interface EvmTableRow {
  projectId: string;
  projectName: string;
  completionPct: number;
  dotToneClass: string;
  cpiDisplay: string;
  cpiToneClass: string;
  spiDisplay: string;
  spiToneClass: string;
  eacDisplay: string;
  vacDisplay: string;
  vacToneClass: string;
}

export function EvmTable({ rows }: { rows: EvmTableRow[] }) {
  const columns: DataListColumn<EvmTableRow>[] = [
    {
      key: "project",
      header: "Project",
      primary: true,
      cell: (r) => (
        <>
          <span className={cn("mr-2 inline-block h-2 w-2 rounded-full align-middle", r.dotToneClass)} aria-hidden />
          <span className="font-medium text-ink align-middle">{r.projectName}</span>
          <span className="ml-2 text-xs text-ink-muted align-middle">{r.completionPct.toFixed(0)}% done</span>
        </>
      ),
    },
    {
      key: "cpi",
      header: "CPI",
      align: "right",
      cell: (r) => <span className={cn("font-medium tabular-nums", r.cpiToneClass)}>{r.cpiDisplay}</span>,
    },
    {
      key: "spi",
      header: "SPI",
      align: "right",
      cell: (r) => <span className={cn("font-medium tabular-nums", r.spiToneClass)}>{r.spiDisplay}</span>,
    },
    {
      key: "eac",
      header: "EAC",
      align: "right",
      cell: (r) => <span className="tabular-nums text-ink-secondary">{r.eacDisplay}</span>,
    },
    {
      key: "vac",
      header: "VAC",
      align: "right",
      cell: (r) => <span className={cn("font-medium tabular-nums", r.vacToneClass)}>{r.vacDisplay}</span>,
    },
  ];

  return (
    <DataList
      columns={columns}
      rows={rows}
      rowKey={(r) => r.projectId}
      tableClassName="min-w-[640px]"
      renderCard={(r) => (
        <div className="flex min-h-[44px] flex-col gap-1.5 px-4 py-3">
          <div className="flex items-center gap-1.5">
            <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", r.dotToneClass)} aria-hidden />
            <span className="truncate text-sm font-medium text-ink">{r.projectName}</span>
            <span className="ml-auto shrink-0 text-xs text-ink-muted">{r.completionPct.toFixed(0)}% done</span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <div className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-ink-muted">CPI</span>
              <span className={cn("min-w-0 truncate font-mono tabular-nums font-medium", r.cpiToneClass)}>
                {r.cpiDisplay}
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-ink-muted">SPI</span>
              <span className={cn("min-w-0 truncate font-mono tabular-nums font-medium", r.spiToneClass)}>
                {r.spiDisplay}
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-ink-muted">EAC</span>
              <span className="min-w-0 truncate font-mono tabular-nums text-ink-secondary">{r.eacDisplay}</span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-ink-muted">VAC</span>
              <span className={cn("min-w-0 truncate font-mono tabular-nums font-medium", r.vacToneClass)}>
                {r.vacDisplay}
              </span>
            </div>
          </div>
        </div>
      )}
    />
  );
}

// ── Project Budgets table (planned / committed / actual / variance / burn) ─

export interface BudgetTableRow {
  projectId: string;
  projectName: string;
  currency: string;
  plannedDisplay: string;
  committedDisplay: string;
  actualDisplay: string;
  varianceDisplay: string | null;
  varianceIsNegative: boolean;
  burnPct: number;
  burnClampedPct: number;
  isOver: boolean;
  isNear: boolean;
}

function BurnBar({ row }: { row: BudgetTableRow }) {
  return (
    <div className="flex items-center gap-3">
      <div className="relative min-w-[80px] flex-1 overflow-visible h-2 rounded-full bg-sunken">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            row.isOver ? "bg-danger" : row.isNear ? "bg-warning" : "bg-accent",
          )}
          style={{ width: `${row.burnClampedPct}%` }}
        />
        {row.isOver && (
          <div className="absolute right-0 top-1/2 h-3 w-2 -translate-y-1/2 rounded-sm bg-danger opacity-70" />
        )}
      </div>
      <span
        className={cn(
          "w-12 shrink-0 text-right text-xs font-medium tabular-nums",
          row.isOver ? "text-danger" : row.isNear ? "text-warning" : "text-ink-secondary",
        )}
      >
        {row.burnPct.toFixed(1)}%
      </span>
    </div>
  );
}

export interface BudgetTotals {
  plannedDisplay: string;
  committedDisplay: string;
  actualDisplay: string;
  varianceDisplay: string;
  varianceIsNegative: boolean;
  burnPct: number;
  burnClampedPct: number;
}

/**
 * Hand-rolled (not DataList) split: the desktop table has a `<tfoot>`
 * totals row DataList has no slot for, so the `≥md` branch below keeps the
 * exact original table+tfoot markup verbatim (pixel-identical to before)
 * and `<md` gets its own card list with a matching totals card, the
 * variance rendered as a chip per F5/the mobile spec.
 */
export function BudgetTable({ rows, totals }: { rows: BudgetTableRow[]; totals: BudgetTotals | null }) {
  if (rows.length === 0) return null;

  return (
    <>
      {/* <md: cards */}
      <ul className="divide-y divide-border-subtle md:hidden">
        {rows.map((r) => (
          <li key={r.projectId} className="flex min-h-[44px] flex-col gap-1.5 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-ink">
                {r.projectName} <span className="text-xs font-normal text-ink-muted">{r.currency}</span>
              </span>
              {r.varianceDisplay !== null && (
                <Badge tone={r.varianceIsNegative ? "danger" : "success"} size="sm" className="shrink-0">
                  {r.varianceDisplay}
                </Badge>
              )}
            </div>
            <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
              <div>
                <span className="block text-ink-muted">Planned</span>
                <span className="block truncate font-mono tabular-nums text-ink-secondary">{r.plannedDisplay}</span>
              </div>
              <div>
                <span className="block text-ink-muted">Committed</span>
                <span className="block truncate font-mono tabular-nums text-ink-secondary">
                  {r.committedDisplay}
                </span>
              </div>
              <div>
                <span className="block text-ink-muted">Actual</span>
                <span className="block truncate font-mono tabular-nums text-ink">{r.actualDisplay}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 pt-0.5">
              <BurnBar row={r} />
              {r.isOver && (
                <Badge tone="danger" size="sm" className="shrink-0">
                  Over
                </Badge>
              )}
            </div>
          </li>
        ))}
        {totals && (
          <li className="flex flex-col gap-1.5 bg-sunken px-4 py-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">Totals</span>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <div>
                <span className="block text-ink-muted">Planned</span>
                <span className="block truncate font-mono tabular-nums font-semibold text-ink">
                  {totals.plannedDisplay}
                </span>
              </div>
              <div>
                <span className="block text-ink-muted">Committed</span>
                <span className="block truncate font-mono tabular-nums font-semibold text-ink">
                  {totals.committedDisplay}
                </span>
              </div>
              <div>
                <span className="block text-ink-muted">Actual</span>
                <span className="block truncate font-mono tabular-nums font-semibold text-ink">
                  {totals.actualDisplay}
                </span>
              </div>
              <div>
                <span className="block text-ink-muted">Variance</span>
                <span
                  className={cn(
                    "block truncate font-mono tabular-nums font-semibold",
                    totals.varianceIsNegative ? "text-danger" : "text-success",
                  )}
                >
                  {totals.varianceDisplay}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-3 pt-0.5">
              <div className="h-2 min-w-[80px] flex-1 overflow-hidden rounded-full bg-canvas">
                <div
                  className={cn(
                    "h-full rounded-full",
                    totals.burnPct > 100 ? "bg-danger" : totals.burnPct >= 80 ? "bg-warning" : "bg-accent",
                  )}
                  style={{ width: `${totals.burnClampedPct}%` }}
                />
              </div>
              <span
                className={cn(
                  "shrink-0 text-xs font-semibold tabular-nums",
                  totals.burnPct > 100 ? "text-danger" : totals.burnPct >= 80 ? "text-warning" : "text-accent",
                )}
              >
                {totals.burnPct.toFixed(1)}%
              </span>
            </div>
          </li>
        )}
      </ul>

      {/* ≥md: original table + tfoot, unchanged */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-border-subtle">
              <th className="text-left px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                Project
              </th>
              <th className="text-right px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                Planned
              </th>
              <th className="text-right px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                Committed
              </th>
              <th className="text-right px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                Actual
              </th>
              <th className="text-right px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                Variance
              </th>
              <th className="px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide min-w-[160px]">
                Burn %
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {rows.map((r) => (
              <tr key={r.projectId} className="hover:bg-sunken transition-colors duration-100">
                <td className="px-5 py-4">
                  <span className="font-medium text-ink">{r.projectName}</span>
                  <span className="ml-2 text-xs text-ink-muted">{r.currency}</span>
                </td>
                <td className="px-5 py-4 text-right tabular-nums text-ink-secondary">{r.plannedDisplay}</td>
                <td className="px-5 py-4 text-right tabular-nums text-ink-secondary">{r.committedDisplay}</td>
                <td className="px-5 py-4 text-right tabular-nums text-ink">{r.actualDisplay}</td>
                <td className="px-5 py-4 text-right tabular-nums font-medium">
                  {r.varianceDisplay === null ? (
                    <span className="text-ink-muted">—</span>
                  ) : (
                    <span className={r.varianceIsNegative ? "text-danger" : "text-success"}>
                      {r.varianceDisplay}
                    </span>
                  )}
                </td>
                <td className="px-5 py-4">
                  <div className="flex items-center gap-3">
                    <BurnBar row={r} />
                    {r.isOver && (
                      <Badge tone="danger" className="shrink-0">
                        Over
                      </Badge>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          {totals && (
            <tfoot>
              <tr className="border-t-2 border-border-subtle bg-sunken">
                <td className="px-5 py-3 text-xs font-semibold text-ink-secondary uppercase tracking-wide">
                  Totals
                </td>
                <td className="px-5 py-3 text-right tabular-nums font-semibold text-ink">
                  {totals.plannedDisplay}
                </td>
                <td className="px-5 py-3 text-right tabular-nums font-semibold text-ink">
                  {totals.committedDisplay}
                </td>
                <td className="px-5 py-3 text-right tabular-nums font-semibold text-ink">{totals.actualDisplay}</td>
                <td
                  className={cn(
                    "px-5 py-3 text-right tabular-nums font-semibold",
                    totals.varianceIsNegative ? "text-danger" : "text-success",
                  )}
                >
                  {totals.varianceDisplay}
                </td>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    <div className="h-2 min-w-[80px] flex-1 overflow-hidden rounded-full bg-canvas">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          totals.burnPct > 100 ? "bg-danger" : totals.burnPct >= 80 ? "bg-warning" : "bg-accent",
                        )}
                        style={{ width: `${totals.burnClampedPct}%` }}
                      />
                    </div>
                    <span
                      className={cn(
                        "tabular-nums text-xs font-semibold w-12 text-right shrink-0",
                        totals.burnPct > 100 ? "text-danger" : totals.burnPct >= 80 ? "text-warning" : "text-accent",
                      )}
                    >
                      {totals.burnPct.toFixed(1)}%
                    </span>
                  </div>
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </>
  );
}

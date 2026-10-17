"use client";

import { DataList, type DataListColumn } from "@/components/ui/data-list";
import { Badge } from "@/components/ui/badge";
import { THead, TH, TR, TD } from "@/components/ui/data-table";
import { ScrollTable } from "@/components/registers/scroll-table";
import { PacingBar } from "@/components/budget/pacing-bar";
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
      cell: (r) => <span className={cn("font-mono font-medium tabular-nums", r.cpiToneClass)}>{r.cpiDisplay}</span>,
    },
    {
      key: "spi",
      header: "SPI",
      align: "right",
      cell: (r) => <span className={cn("font-mono font-medium tabular-nums", r.spiToneClass)}>{r.spiDisplay}</span>,
    },
    {
      key: "eac",
      header: "EAC",
      align: "right",
      cell: (r) => <span className="whitespace-nowrap font-mono tabular-nums text-ink-secondary">{r.eacDisplay}</span>,
    },
    {
      key: "vac",
      header: "VAC",
      align: "right",
      cell: (r) => <span className={cn("whitespace-nowrap font-mono font-medium tabular-nums", r.vacToneClass)}>{r.vacDisplay}</span>,
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

// ── Project Budgets table (planned / committed / actual / variance / pacing) ─

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
  /** Delivery progress; the pacing tick marks where spend should be. */
  completionPct: number;
  hasPlan: boolean;
}

export interface BudgetTotals {
  /** Shown once on the totals line; the figures below are numbers only. */
  currency: string;
  plannedDisplay: string;
  committedDisplay: string;
  actualDisplay: string;
  varianceDisplay: string;
  varianceIsNegative: boolean;
  burnPct: number;
  completionPct: number;
}

/**
 * Hand-rolled split (DataList has no tfoot slot): <md card list with a
 * totals card; >=md the DataTable primitives with numeric right-aligned
 * cells and a pacing bar per project. Prints as a plain table.
 */
export function BudgetTable({ rows, totals }: { rows: BudgetTableRow[]; totals: BudgetTotals | null }) {
  if (rows.length === 0) return null;

  return (
    <>
      {/* <md: cards */}
      <ul className="divide-y divide-border-subtle md:hidden print:hidden">
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
            <PacingBar burnPct={r.burnPct} expectedPct={r.completionPct} hasPlan={r.hasPlan} className="pt-0.5" />
          </li>
        ))}
        {totals && (
          <li className="flex flex-col gap-1.5 bg-sunken px-4 py-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
              Totals · {totals.currency}
            </span>
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
                    totals.varianceIsNegative ? "text-danger-ink" : "text-success-ink",
                  )}
                >
                  {totals.varianceDisplay}
                </span>
              </div>
            </div>
            <PacingBar burnPct={totals.burnPct} expectedPct={totals.completionPct} className="pt-0.5" />
          </li>
        )}
      </ul>

      {/* >=md (and print): DataTable primitives */}
      <div className="hidden md:block print:block">
        <ScrollTable bare label="Project budgets" className="print:min-w-0">
          <THead>
            <TR>
              <TH>Project</TH>
              <TH align="right">Planned</TH>
              <TH align="right">Committed</TH>
              <TH align="right">Actual</TH>
              <TH align="right">Variance</TH>
              <TH>Burn vs progress</TH>
            </TR>
          </THead>
          <tbody>
            {rows.map((r) => (
              <TR key={r.projectId} className="hover:bg-sunken transition-colors duration-100 print:break-inside-avoid">
                {/* wraps (no nowrap): the name column takes whatever the money columns leave, so the table fits without clipping or truncating names */}
                <TD>
                  <span className="font-medium text-ink">{r.projectName}</span>
                  <span className="ml-1.5 whitespace-nowrap font-mono text-xs text-ink-muted">{r.currency}</span>
                </TD>
                <TD align="right" numeric className="whitespace-nowrap text-ink-secondary">{r.plannedDisplay}</TD>
                <TD align="right" numeric className="whitespace-nowrap text-ink-secondary">{r.committedDisplay}</TD>
                <TD align="right" numeric className="whitespace-nowrap">{r.actualDisplay}</TD>
                <TD align="right" numeric className="whitespace-nowrap font-medium">
                  {r.varianceDisplay === null ? (
                    <span className="text-ink-muted">—</span>
                  ) : (
                    <span className={r.varianceIsNegative ? "text-danger-ink" : "text-success-ink"}>
                      {r.varianceDisplay}
                    </span>
                  )}
                </TD>
                <TD>
                  <PacingBar burnPct={r.burnPct} expectedPct={r.completionPct} hasPlan={r.hasPlan} stacked />
                </TD>
              </TR>
            ))}
          </tbody>
          {totals && (
            <tfoot>
              <TR className="border-t-2 border-border-subtle bg-sunken font-semibold print:break-inside-avoid">
                <TD className="whitespace-nowrap text-xs uppercase tracking-wide text-ink-secondary">
                  Totals · {totals.currency}
                </TD>
                <TD align="right" numeric className="whitespace-nowrap">{totals.plannedDisplay}</TD>
                <TD align="right" numeric className="whitespace-nowrap">{totals.committedDisplay}</TD>
                <TD align="right" numeric className="whitespace-nowrap">{totals.actualDisplay}</TD>
                <TD
                  align="right"
                  numeric
                  className={totals.varianceIsNegative ? "whitespace-nowrap text-danger-ink" : "whitespace-nowrap text-success-ink"}
                >
                  {totals.varianceDisplay}
                </TD>
                <TD>
                  <PacingBar burnPct={totals.burnPct} expectedPct={totals.completionPct} stacked />
                </TD>
              </TR>
            </tfoot>
          )}
        </ScrollTable>
      </div>
    </>
  );
}

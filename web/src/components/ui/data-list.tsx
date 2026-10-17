"use client";

import { useRouter } from "next/navigation";
import { type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

export interface DataListColumn<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Rendered as the card title below md. Exactly one column should set this. */
  primary?: boolean;
  /** Rendered as a chip in the card's badge row below md (e.g. status/priority pills). */
  badge?: boolean;
  /** Dropped from the table at md+ too (rare — prefer the table's own column set). */
  hideOnMobile?: boolean;
  align?: "left" | "right" | "center";
}

export interface DataListProps<T> {
  columns: DataListColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  href?: (row: T) => string | null | undefined;
  empty?: ReactNode;
  /** Full override for the below-md card body; the default derives one from `columns`. */
  renderCard?: (row: T) => ReactNode;
  className?: string;
  /** Extra classes for the ≥md <table> — e.g. a min-w-[Npx] tuned for a wide register. */
  tableClassName?: string;
}

const alignClass: Record<NonNullable<DataListColumn<unknown>["align"]>, string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

/**
 * Generic responsive register table (F5). This is the CLIENT version (row
 * click handlers, router navigation). A server component cannot pass it
 * function props (`cell`, `rowKey`, `href`): use `DataListStatic`
 * (data-list-static.tsx), the same layout with link rows and no handlers.
 * Pages keep their own column
 * definitions and pass them here instead of hand-rolling a `<table>`:
 * ≥md renders a plain `<table>` (the exact class signature already used by
 * register tables, e.g. change-table.tsx); <md renders a card list, each
 * card a >=44px touch target with the primary column as its title, `badge`
 * columns as chips, the next two visible non-primary/non-badge columns as
 * label/value pairs, and a chevron when the row is clickable.
 */
export function DataList<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  href,
  empty,
  renderCard,
  className,
  tableClassName,
}: DataListProps<T>) {
  const router = useRouter();
  const clickable = Boolean(onRowClick || href);

  function activate(row: T) {
    if (onRowClick) {
      onRowClick(row);
      return;
    }
    const target = href?.(row);
    if (target) router.push(target);
  }

  if (rows.length === 0) {
    return <>{empty ?? null}</>;
  }

  // hideOnMobile only drops a column from the <md card derivation below —
  // the >=md table always renders every column the caller defined.
  const tableColumns = columns;

  return (
    <div className={className}>
      {/* ≥md: table */}
      <div className="hidden overflow-x-auto md:block">
        <table className={cn("w-full text-sm", tableClassName)}>
          <thead>
            <tr className="border-b border-border-subtle">
              {tableColumns.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    "px-5 py-3 text-xs font-medium uppercase tracking-wide text-ink-muted whitespace-nowrap",
                    alignClass[c.align ?? "left"],
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? () => activate(row) : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          activate(row);
                        }
                      }
                    : undefined
                }
                className={cn(
                  "transition-colors duration-100",
                  clickable &&
                    "cursor-pointer hover:bg-sunken focus-ring-inset",
                )}
              >
                {tableColumns.map((c) => (
                  <td key={c.key} className={cn("px-5 py-3.5", alignClass[c.align ?? "left"])}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* <md: cards */}
      <ul className="divide-y divide-border-subtle md:hidden">
        {rows.map((row) => {
          if (renderCard) {
            return <li key={rowKey(row)}>{renderCard(row)}</li>;
          }
          const primaryCol = columns.find((c) => c.primary);
          const badgeCols = columns.filter((c) => c.badge);
          const secondaryCols = columns
            .filter((c) => !c.primary && !c.badge && !c.hideOnMobile)
            .slice(0, 2);

          const card = (
            <div className="flex min-h-[44px] items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 space-y-1.5">
                {primaryCol && (
                  <div className="line-clamp-2 break-words text-sm font-medium text-ink">{primaryCol.cell(row)}</div>
                )}
                {badgeCols.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {badgeCols.map((c) => (
                      <span key={c.key}>{c.cell(row)}</span>
                    ))}
                  </div>
                )}
                {secondaryCols.map((c) => (
                  <div key={c.key} className="flex items-baseline gap-1.5 text-xs">
                    <span className="shrink-0 text-ink-muted">{c.header}</span>
                    <span className="min-w-0 truncate text-ink-secondary">{c.cell(row)}</span>
                  </div>
                ))}
              </div>
              {clickable && (
                <ChevronRight size={18} className="shrink-0 text-ink-muted" aria-hidden="true" />
              )}
            </div>
          );

          return (
            <li key={rowKey(row)}>
              {clickable ? (
                <button
                  type="button"
                  onClick={() => activate(row)}
                  className="focus-ring-inset block w-full text-left transition-colors hover:bg-sunken"
                >
                  {card}
                </button>
              ) : (
                card
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

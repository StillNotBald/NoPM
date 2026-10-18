import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import type { DataListColumn } from "@/components/ui/data-list";

export interface DataListStaticProps<T> {
  columns: DataListColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Row destination. Rows become real links (work without JS, middle-click, open in new tab). */
  href?: (row: T) => string | null | undefined;
  empty?: ReactNode;
  /** Full override for the below-md card body. */
  renderCard?: (row: T) => ReactNode;
  className?: string;
  /** Extra classes for the ≥md <table>. */
  tableClassName?: string;
}

const alignClass: Record<NonNullable<DataListColumn<unknown>["align"]>, string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

/**
 * Server-component version of <DataList>: identical layout (table at md+,
 * cards below), but no hooks and no event handlers, so a server page can pass
 * it function props (`cell`, `rowKey`, `href`) directly. Navigation is by
 * link: at md+ the primary column's link is stretched over the whole row
 * (`after:absolute after:inset-0`), below md the whole card is the link.
 * Need an `onRowClick` (opening the inspector)? Use the client <DataList>.
 */
export function DataListStatic<T>({
  columns,
  rows,
  rowKey,
  href,
  empty,
  renderCard,
  className,
  tableClassName,
}: DataListStaticProps<T>) {
  if (rows.length === 0) return <>{empty ?? null}</>;

  const primaryCol = columns.find((c) => c.primary) ?? columns[0];

  return (
    <div className={className}>
      {/* ≥md: table */}
      <div className="hidden overflow-x-auto md:block">
        <table className={cn("w-full text-sm", tableClassName)}>
          <thead>
            <tr className="border-b border-border-subtle">
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn(
                    "whitespace-nowrap px-5 py-3 text-xs font-medium uppercase tracking-wide text-ink-muted",
                    alignClass[c.align ?? "left"],
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {rows.map((row) => {
              const target = href?.(row);
              return (
                <tr
                  key={rowKey(row)}
                  className={cn("relative transition-colors duration-100", target && "hover:bg-well")}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={cn("px-5 py-3.5", alignClass[c.align ?? "left"])}>
                      {target && c.key === primaryCol?.key ? (
                        <Link
                          href={target}
                          className="focus-ring-inset after:absolute after:inset-0 after:content-['']"
                        >
                          {c.cell(row)}
                        </Link>
                      ) : (
                        c.cell(row)
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* <md: cards */}
      <ul className="divide-y divide-border-subtle md:hidden">
        {rows.map((row) => {
          if (renderCard) return <li key={rowKey(row)}>{renderCard(row)}</li>;
          const target = href?.(row);
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
              {target && <ChevronRight size={18} className="shrink-0 text-ink-muted" aria-hidden="true" />}
            </div>
          );

          return (
            <li key={rowKey(row)}>
              {target ? (
                <Link href={target} className="focus-ring-inset block transition-colors hover:bg-well">
                  {card}
                </Link>
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

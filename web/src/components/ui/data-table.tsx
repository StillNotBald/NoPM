/**
 * DataTable primitives: Table / THead / TH / TR / TD.
 *
 * One table recipe for registers: unified header style (uppercase mono 11px
 * label on a sunken band) and cell padding driven by the `--cell-py` /
 * `--cell-px` density tokens in globals.css, so `.density-compact` works
 * without class-sniffing selectors.
 *
 *   <Table>
 *     <THead><TR><TH>Name</TH><TH align="right">Cost</TH></TR></THead>
 *     <tbody><TR><TD>Alpha</TD><TD align="right" numeric>1,200</TD></TR></tbody>
 *   </Table>
 *
 * `Table` wraps in a bordered, horizontally scrollable surface. Pass `bare`
 * to skip the border (the table still scrolls inside its own container, so
 * the page never scrolls horizontally).
 */
import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Align = "left" | "right" | "center";
const alignClass: Record<Align, string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

const cellPad = { padding: "var(--cell-py) var(--cell-px)" } as const;

export function Table({
  className,
  wrapperClassName,
  bare = false,
  ...props
}: HTMLAttributes<HTMLTableElement> & { wrapperClassName?: string; bare?: boolean }) {
  const table = <table className={cn("w-full border-collapse text-sm", className)} {...props} />;
  if (bare) return <div className={cn("max-w-full overflow-x-auto", wrapperClassName)}>{table}</div>;
  return (
    <div
      className={cn(
        "overflow-x-auto rounded-lg border border-border-subtle bg-surface",
        wrapperClassName,
      )}
    >
      {table}
    </div>
  );
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b border-border-subtle bg-well/50", className)} {...props} />;
}

export function TH({
  align = "left",
  className,
  style,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { align?: Align }) {
  return (
    <th
      scope="col"
      className={cn(
        "whitespace-nowrap font-mono text-2xs font-medium uppercase tracking-wider text-ink-muted",
        alignClass[align],
        className,
      )}
      style={{ ...cellPad, ...style }}
      {...props}
    />
  );
}

export function TR({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-b border-border-subtle last:border-b-0", className)} {...props} />;
}

export function TD({
  align = "left",
  numeric = false,
  className,
  style,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { align?: Align; numeric?: boolean }) {
  return (
    <td
      className={cn("text-ink", alignClass[align], numeric && "whitespace-nowrap font-mono tabular-nums", className)}
      style={{ ...cellPad, ...style }}
      {...props}
    />
  );
}

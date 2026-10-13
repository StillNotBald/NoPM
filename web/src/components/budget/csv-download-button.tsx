"use client";

import { Download } from "lucide-react";
import { toCsv } from "@/lib/export/csv";
import { cn } from "@/lib/cn";

/**
 * Client-side CSV download of the table the user is looking at. The
 * server-linked ExportCsvButton only points at GET /api/export, so it cannot
 * export figures a page derives (burn, utilisation, variance). Rows are built
 * by the page and passed as plain primitives; toCsv() applies the shared
 * RFC 4180 + BOM + formula-injection guard. Amounts should be passed as plain
 * numbers so spreadsheets can sum them. Hidden when printing.
 */
export function CsvDownloadButton({
  filename,
  header,
  rows,
  label = "Export CSV",
  className,
}: {
  filename: string;
  header: string[];
  rows: (string | number | null)[][];
  label?: string;
  className?: string;
}) {
  const empty = rows.length === 0;
  function download() {
    const blob = new Blob([toCsv(header, rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  return (
    <button
      type="button"
      onClick={download}
      disabled={empty}
      className={cn(
        "focus-ring inline-flex h-11 items-center justify-center gap-1.5 rounded-md border border-border-subtle",
        "bg-surface px-3 text-sm font-medium text-ink transition-colors duration-150 hover:bg-sunken",
        "disabled:cursor-not-allowed disabled:opacity-50 sm:h-9 print:hidden",
        className,
      )}
    >
      <Download size={14} aria-hidden="true" />
      {label}
    </button>
  );
}

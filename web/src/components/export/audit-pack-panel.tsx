"use client";

import { useState } from "react";
import { FileArchive } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

/**
 * Audit pack (M3): pick a date range, download one artefact for an external
 * auditor as CSV or PDF. Plain links into GET /api/export?entity=audit_pack,
 * so the browser handles the download. Only render this for an admin or
 * manager; the server enforces the same rule and answers 403 otherwise.
 *
 * Phone width: the button, the two date fields and the two download links each
 * take a full-width row (44px touch targets) and sit side by side from sm up.
 */
const linkClass = cn(
  "inline-flex h-11 items-center justify-center gap-1.5 rounded-md border border-border-subtle",
  "bg-surface px-3 text-sm font-medium text-ink transition-colors duration-150",
  "hover:bg-well focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:h-9",
);

export function AuditPackPanel({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const href = (format: "csv" | "pdf") => {
    const p = new URLSearchParams({ entity: "audit_pack", format });
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return `/api/export?${p.toString()}`;
  };

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="audit-pack-form"
        onClick={() => setOpen((v) => !v)}
        className={cn(linkClass, "w-full sm:w-auto sm:self-start")}
      >
        <FileArchive size={14} />
        Audit pack
      </button>

      {open && (
        <div
          id="audit-pack-form"
          className="flex flex-col gap-3 rounded-md border border-border-subtle bg-canvas p-3 sm:flex-row sm:flex-wrap sm:items-end"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="audit-pack-from" className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              From (UTC)
            </label>
            <Input
              id="audit-pack-from"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              className="sm:w-40"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="audit-pack-to" className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              To (UTC)
            </label>
            <Input
              id="audit-pack-to"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              className="sm:w-40"
            />
          </div>
          <a href={href("pdf")} className={linkClass}>
            Download PDF
          </a>
          <a href={href("csv")} className={linkClass}>
            Download CSV
          </a>
          <p className="text-xs text-ink-muted sm:basis-full">
            Every change request raised or decided in the range, with approver, evidence, implemented date and the change audit trail. The download is recorded in the audit log.
          </p>
        </div>
      )}
    </div>
  );
}

"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

type DeckFormat = "pptx" | "html" | "pdf";

const FORMAT_LABELS: Record<DeckFormat, string> = {
  pptx: "PowerPoint (.pptx)",
  html: "HTML report",
  pdf:  "PDF",
};

/**
 * "Export board pack" button — primary action is PPTX; a chevron opens a
 * format picker for html / pdf.  Calls GET /api/reports/deck?format=<fmt>
 * and triggers a browser download.
 */
export function ExportBoardPack() {
  const [busy, setBusy] = useState<DeckFormat | null>(null);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  async function download(fmt: DeckFormat) {
    setOpen(false);
    setBusy(fmt);
    try {
      const res = await fetch(`/api/reports/deck?format=${encodeURIComponent(fmt)}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const text = await res.text();
        console.error("Export failed:", text);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cd = res.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(cd);
      a.download = match?.[1] ?? `board-pack.${fmt}`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(null);
    }
  }

  const isPptxBusy = busy === "pptx";

  return (
    <div className="relative flex items-center">
      {/* Primary: PPTX download */}
      <Button
        variant="primary"
        disabled={busy !== null}
        onClick={() => download("pptx")}
        className="rounded-r-none h-9 px-3.5 text-sm"
        aria-label="Export board pack as PowerPoint"
      >
        {isPptxBusy ? (
          <>
            <Spinner size="sm" className="mr-2" />
            Exporting…
          </>
        ) : (
          "Export board pack"
        )}
      </Button>

      {/* Chevron for format menu */}
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Choose export format"
        className={[
          "flex h-9 w-8 items-center justify-center",
          "rounded-l-none border-l border-accent-ink/20",
          "bg-accent text-accent-ink",
          "hover:bg-accent-hover transition-colors",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        ].join(" ")}
      >
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={menuRef}
            role="menu"
            className={[
              "absolute right-0 top-full z-50 mt-1.5",
              "min-w-[160px] rounded-lg border border-border-subtle",
              "bg-surface py-1 shadow-md",
            ].join(" ")}
          >
            {(Object.keys(FORMAT_LABELS) as DeckFormat[]).map((fmt) => (
              <button
                key={fmt}
                role="menuitem"
                onClick={() => download(fmt)}
                disabled={busy !== null}
                className={[
                  "flex w-full items-center gap-2 px-3.5 py-2 text-left text-sm",
                  "text-ink hover:bg-sunken transition-colors",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                  fmt === "pptx" ? "font-medium" : "",
                ].join(" ")}
              >
                {busy === fmt && <Spinner size="sm" />}
                {FORMAT_LABELS[fmt]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

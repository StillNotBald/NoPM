"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";

type DeckFormat = "pptx" | "html" | "pdf";

const FORMAT_LABELS: Record<DeckFormat, string> = {
  pptx: "PowerPoint (.pptx)",
  html: "HTML report",
  pdf:  "PDF",
};

/**
 * What a failed export should say. The deck route answers `{ error }` for a
 * missing scope (403: it needs both audit:read and budget:read because the deck
 * carries budget figures) or a bad format (422); anything else is a server fault.
 */
async function failureMessage(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string") detail = body.error;
  } catch {
    // not JSON: fall through to the status-based text
  }
  if (res.status === 403) {
    return detail || "Your role cannot export the board pack. It needs audit and budget read access.";
  }
  if (res.status === 401) return "Your session has expired. Sign in again to export.";
  return detail || `The server could not build the board pack (HTTP ${res.status}).`;
}

/**
 * "Export board pack" button — primary action is PPTX; a chevron opens a
 * format picker for html / pdf.  Calls GET /api/reports/deck?format=<fmt>
 * and triggers a browser download.
 *
 * Scope: the deck route takes a format (and optional sections) only, so the
 * pack always covers EVERY project in the workspace. When the page's own
 * filters are active (`filtered`), the button says so instead of implying the
 * pack matches what is on screen. Outcomes are announced (toast + live region)
 * so a failure is never silent.
 */
export function ExportBoardPack({ filtered = false }: { filtered?: boolean }) {
  const [busy, setBusy] = useState<DeckFormat | null>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const chevronRef = useRef<HTMLButtonElement | null>(null);
  const toast = useToast();

  const label = filtered ? "Export all projects" : "Export board pack";
  const scopeNote = filtered
    ? "The board pack covers every project. Page filters are not applied."
    : "Exports every project in the workspace.";

  // Esc closes the menu and hands focus back to the chevron; focus the first
  // format when it opens so the keyboard path starts inside it.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        chevronRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  async function download(fmt: DeckFormat) {
    setOpen(false);
    setBusy(fmt);
    setStatus("Exporting the board pack…");
    try {
      const res = await fetch(`/api/reports/deck?format=${encodeURIComponent(fmt)}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const message = await failureMessage(res);
        setStatus(`Export failed. ${message}`);
        toast.error(`Export failed. ${message}`, { duration: 8000 });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const cd = res.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(cd);
      const filename = match?.[1] ?? `board-pack.${fmt}`;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setStatus(`Board pack downloaded: ${filename}.`);
      toast.success(`Board pack downloaded (${filename}).`);
    } catch {
      const message = "Check your connection and try again.";
      setStatus(`Export failed. ${message}`);
      toast.error(`Export failed. ${message}`, { duration: 8000 });
    } finally {
      setBusy(null);
    }
  }

  const isPptxBusy = busy === "pptx";

  return (
    <div className="relative flex items-center">
      {/* Screen-reader outcome of the last export (the toast is the visual one) */}
      <span role="status" aria-live="polite" className="sr-only">
        {status}
      </span>

      {/* Primary: PPTX download */}
      <Button
        variant="primary"
        disabled={busy !== null}
        onClick={() => download("pptx")}
        className="rounded-r-none h-9 px-3.5 text-sm"
        aria-label={`${label} as PowerPoint`}
        title={scopeNote}
      >
        {isPptxBusy ? (
          <>
            <Spinner size="sm" className="mr-2" />
            Exporting…
          </>
        ) : (
          label
        )}
      </Button>

      {/* Chevron for format menu — F6: 44px hit area via an invisible
          ::before pseudo-element; the 36x32 visual button is unchanged. */}
      <button
        ref={chevronRef}
        type="button"
        disabled={busy !== null}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Choose export format"
        className={[
          "relative flex h-9 w-8 items-center justify-center",
          "rounded-l-none border-l border-accent-ink/20",
          "bg-accent text-accent-ink",
          "hover:bg-accent-hover transition-colors",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "focus-ring",
          "before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
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
            aria-label="Export format"
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              const items = Array.from(
                menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
              );
              if (items.length === 0) return;
              e.preventDefault();
              const i = items.indexOf(document.activeElement as HTMLElement);
              const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
              items[next].focus();
            }}
            className={[
              "absolute right-0 top-full z-50 mt-1.5",
              "min-w-[160px] rounded-lg border border-border-subtle",
              "bg-surface py-1 shadow-md",
            ].join(" ")}
          >
            {(Object.keys(FORMAT_LABELS) as DeckFormat[]).map((fmt) => (
              <button
                key={fmt}
                type="button"
                role="menuitem"
                onClick={() => download(fmt)}
                disabled={busy !== null}
                className={[
                  "focus-ring flex min-h-[44px] w-full items-center gap-2 px-3.5 py-2 text-left text-sm sm:min-h-0",
                  "text-ink hover:bg-well transition-colors",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                  fmt === "pptx" ? "font-medium" : "",
                ].join(" ")}
              >
                {busy === fmt && <Spinner size="sm" />}
                {FORMAT_LABELS[fmt]}
              </button>
            ))}
            <p className="border-t border-border-subtle px-3.5 py-2 text-xs text-ink-muted">{scopeNote}</p>
          </div>
        </>
      )}
    </div>
  );
}

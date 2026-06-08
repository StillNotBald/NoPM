"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * DownloadOnePagerButton — triggers client-side jsPDF generation of the NoPM
 * case study one-pager and saves it as nopm-case-study.pdf.
 *
 * Lazy-imports the generator so the jsPDF bundle is only loaded on click,
 * keeping the initial page weight small.
 */
export function DownloadOnePagerButton() {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    if (loading) return;
    setLoading(true);
    try {
      const { generateOnePager } = await import("@/lib/reports/one-pager");
      generateOnePager();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={handleClick}
      disabled={loading}
      aria-label="Download case study as a one-page PDF"
    >
      {loading ? (
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Generating…
        </span>
      ) : (
        <span className="flex items-center gap-1.5">
          <DownloadIcon />
          Download one-pager (PDF)
        </span>
      )}
    </Button>
  );
}

function DownloadIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

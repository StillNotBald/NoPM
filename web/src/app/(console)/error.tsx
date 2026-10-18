"use client";

import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Scoped error boundary for the (console) layout segment.
 * Catches rendering errors in any console page without taking down the shell.
 * Does NOT expose stack traces in production.
 *
 * The card is a `role="alert"` (screen readers are told the page failed) and
 * its heading takes focus, so keyboard users land on the recovery buttons
 * instead of an empty page behind a stale focus position.
 *
 * "Try again" calls `retry()` (Next 16.3+), which re-fetches and re-renders the
 * segment; `reset()` only clears the error state and re-renders the same failed
 * payload, so for a transient server error it looks like a button that does
 * nothing. `reset` stays as the fallback for an older runtime (same contract as
 * src/app/error.tsx).
 */
export default function ConsoleError({
  error,
  retry,
  reset,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
  reset?: () => void;
}) {
  const tryAgain = retry ?? reset;
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // Log to an error-reporting service in production; console is fine for now.
    console.error("[console-error-boundary]", error);
  }, [error]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-12">
      <div
        role="alert"
        className="w-full max-w-sm rounded-lg border border-border-subtle bg-surface p-8 text-center"
      >
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger/10">
          <AlertTriangle size={22} className="text-danger-ink" aria-hidden="true" />
        </div>

        <h1
          ref={headingRef}
          tabIndex={-1}
          className="mb-1 text-base font-semibold text-ink focus:outline-none"
        >
          Something went wrong
        </h1>

        <p className="mb-6 text-sm text-ink-secondary">
          This page ran into an unexpected error. Your data is safe — try
          refreshing or go back to the dashboard.
        </p>

        {/* Show the digest in dev or when Vercel provides one — never the raw stack */}
        {error.digest && (
          <p className="mb-5 font-mono text-xs text-ink-muted">
            ref: {error.digest}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button
            variant="primary"
            size="sm"
            onClick={() => tryAgain?.()}
          >
            Try again
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => (window.location.href = "/dashboard")}
          >
            Go to dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}

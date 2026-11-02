"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/marketing/wordmark";

/**
 * Root error boundary — catches rendering errors on the marketing/entry
 * surface (/, /login, /case-study) that sits outside the (console) segment,
 * which has its own scoped boundary. Recovery points back to the landing
 * page and the demo entry rather than the console dashboard.
 * Does NOT expose stack traces in production.
 *
 * "Try again" calls `retry()` (Next 16.3+), which re-fetches and re-renders the
 * segment; `reset()` only clears the error state and re-renders the same
 * failed payload, so for a transient server error it would look like a button
 * that does nothing. `reset` stays as the fallback for an older runtime.
 */
export default function RootError({
  error,
  retry,
  reset,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
  reset?: () => void;
}) {
  useEffect(() => {
    // Log to an error-reporting service in production; console is fine for now.
    console.error("[root-error-boundary]", error);
  }, [error]);

  const tryAgain = retry ?? reset;

  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center px-4 py-12">
      <Wordmark className="mb-6" />
      <div className="w-full max-w-sm rounded-lg border border-border-subtle bg-surface p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger/10">
          <AlertTriangle size={22} className="text-danger-ink" aria-hidden="true" />
        </div>

        <h1 className="mb-1 text-base font-semibold text-ink">
          Something went wrong
        </h1>

        <p className="mb-6 text-sm text-ink-secondary">
          This page hit an error. Try again, or go back.
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
            className="max-sm:h-11"
            onClick={() => tryAgain?.()}
          >
            Try again
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="max-sm:h-11"
            onClick={() => (window.location.href = "/")}
          >
            Back to landing
          </Button>
        </div>

        <form method="POST" action="/api/auth/demo-login" className="mt-3">
          <button
            type="submit"
            className="inline-flex min-h-11 items-center rounded-md px-2 text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline focus-ring"
          >
            Or jump into the live demo →
          </button>
        </form>
      </div>
    </main>
  );
}

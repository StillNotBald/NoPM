"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Root error boundary — catches rendering errors on the marketing/entry
 * surface (/, /login, /case-study) that sits outside the (console) segment,
 * which has its own scoped boundary. Recovery points back to the landing
 * page and the demo entry rather than the console dashboard.
 * Does NOT expose stack traces in production.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to an error-reporting service in production; console is fine for now.
    console.error("[root-error-boundary]", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm rounded-lg border border-border-subtle bg-surface p-8 text-center shadow-md">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger/10">
          <AlertTriangle size={22} className="text-danger" />
        </div>

        <h2 className="mb-1 text-base font-semibold text-ink">
          Something went wrong
        </h2>

        <p className="mb-6 text-sm text-ink-secondary">
          This page ran into an unexpected error. Try again, or head back to
          the landing page — you can also jump straight into the live demo.
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
            onClick={reset}
          >
            Try again
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => (window.location.href = "/")}
          >
            Back to landing
          </Button>
        </div>

        <form method="POST" action="/api/auth/demo-login" className="mt-3">
          <button
            type="submit"
            className="text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline"
          >
            Or jump into the live demo →
          </button>
        </form>
      </div>
    </div>
  );
}

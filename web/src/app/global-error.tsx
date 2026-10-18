"use client";

import { useEffect } from "react";
import "./globals.css";

/**
 * Last-resort boundary for a throw in the root layout itself (e.g. the cookie
 * or Supabase read there), where error.tsx cannot render because it lives
 * inside that layout. Without this file the visitor gets Next's built-in
 * screen with no brand, no recovery and no way back.
 *
 * It replaces the root layout, so it brings its own <html>/<body> and global
 * CSS. No theme cookie is read (that read may be what failed): `theme-system`
 * follows the OS colour scheme. Plain elements and links only — nothing here
 * may depend on code that could be the thing that broke.
 */
export default function GlobalError({
  error,
  retry,
  reset,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
  reset?: () => void;
}) {
  useEffect(() => {
    console.error("[global-error-boundary]", error);
  }, [error]);

  const tryAgain = retry ?? reset;

  return (
    <html lang="en" className="theme-system h-full antialiased">
      <body className="min-h-full">
        <main className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
          <div className="w-full max-w-sm rounded-lg border border-border-subtle bg-surface p-8 text-center">
            <h1 className="mb-1 text-base font-semibold text-ink">Something went wrong</h1>
            <p className="mb-6 text-sm text-ink-secondary">
              NoPM could not load this page. Try again, or head back to the landing page.
            </p>
            {error.digest && (
              <p className="mb-5 font-mono text-xs text-ink-muted">ref: {error.digest}</p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
              <button
                type="button"
                onClick={() => tryAgain?.()}
                className="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-4 text-sm font-semibold text-accent-ink hover:bg-accent-hover focus-ring"
              >
                Try again
              </button>
              {/* A plain anchor on purpose: a full navigation, no client router. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a
                href="/"
                className="inline-flex min-h-11 items-center justify-center rounded-md border border-border-subtle px-4 text-sm text-ink hover:bg-well focus-ring"
              >
                Back to landing
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}

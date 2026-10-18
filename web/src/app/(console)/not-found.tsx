import Link from "next/link";
import { SearchX } from "lucide-react";

/**
 * 404 for a signed-in console route (e.g. a stale project id). Renders inside
 * the shell and sends the operator back into the product — the root
 * not-found.tsx points at the marketing site, which is wrong for someone who
 * is mid-session.
 */
export default function ConsoleNotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm rounded-lg border border-border-subtle bg-surface p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-well">
          <SearchX size={22} className="text-ink-secondary" aria-hidden="true" />
        </div>

        <h1 className="mb-1 text-base font-semibold text-ink">Page not found</h1>

        <p className="mb-6 text-sm text-ink-secondary">
          This record doesn&apos;t exist or has moved. Check the link, or search for it from the
          command palette.
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Link
            href="/dashboard"
            className="focus-ring inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-3 text-sm font-semibold text-accent-ink hover:bg-accent-hover sm:min-h-0 sm:h-8"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}

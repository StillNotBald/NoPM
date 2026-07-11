import Link from "next/link";
import { SearchX } from "lucide-react";

/**
 * Root 404 — matches the visual language of the root error boundary
 * (src/app/error.tsx) and the scoped (console) error boundary. Points back
 * to the landing page and the case study rather than anywhere console-side.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm rounded-lg border border-border-subtle bg-surface p-8 text-center shadow-md">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-sunken">
          <SearchX size={22} className="text-ink-secondary" />
        </div>

        <h2 className="mb-1 text-base font-semibold text-ink">
          Page not found
        </h2>

        <p className="mb-6 text-sm text-ink-secondary">
          The page you&apos;re looking for doesn&apos;t exist or has moved.
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Link
            href="/"
            className="inline-flex h-8 items-center justify-center rounded-md bg-accent px-3 text-sm font-semibold text-accent-ink hover:bg-accent-hover"
          >
            Back to landing
          </Link>
          <Link
            href="/case-study"
            className="inline-flex h-8 items-center justify-center rounded-md border border-border-subtle bg-surface px-3 text-sm text-ink hover:bg-sunken"
          >
            Read the case study
          </Link>
        </div>
      </div>
    </div>
  );
}

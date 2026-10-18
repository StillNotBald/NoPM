import type { Metadata } from "next";
import { SearchX } from "lucide-react";
import { ButtonLink } from "@/components/marketing/button-link";
import { Wordmark } from "@/components/marketing/wordmark";

// Next adds `noindex` to a 404 on its own; the title makes the tab/history
// entry say what happened instead of showing the site's default.
export const metadata: Metadata = { title: "Page not found" };

/**
 * Root 404 — matches the visual language of the root error boundary
 * (src/app/error.tsx) and the scoped (console) error boundary. Points back
 * to the landing page and the case study rather than anywhere console-side.
 * A lost visitor gets the wordmark (site context), one h1 and 44px targets.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center px-4 py-12">
      <Wordmark className="mb-6" />
      <div className="w-full max-w-sm rounded-lg border border-border-subtle bg-surface p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-well">
          <SearchX size={22} className="text-ink-secondary" aria-hidden="true" />
        </div>

        <h1 className="mb-1 text-base font-semibold text-ink">
          Page not found
        </h1>

        <p className="mb-6 text-sm text-ink-secondary">
          The page you&apos;re looking for doesn&apos;t exist or has moved.
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <ButtonLink href="/" size="sm">
            Back to landing
          </ButtonLink>
          <ButtonLink href="/case-study" variant="secondary" size="sm">
            Read the case study
          </ButtonLink>
        </div>
      </div>
    </main>
  );
}

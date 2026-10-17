"use client";

import { usePathname } from "next/navigation";
import { Info, X } from "lucide-react";
import { useSeededPreferences } from "@/components/onboarding/use-seeded-preferences";
import type { PrefsSeed } from "@/lib/onboarding/seed";
import { hintFor, hintDocUrl, isHintDismissed, dismissHint } from "@/lib/onboarding/hints";

/**
 * Page hint (R-78) — a slim, one-line, dismissible strip explaining what the
 * current console page is for. Mounted once by app-shell.tsx directly below
 * <Breadcrumbs />; renders nothing on pages with no registry entry (see
 * lib/onboarding/hints.ts — /dashboard and /start deliberately have none, so
 * every page shows at most one onboarding surface).
 *
 * Reads/writes only the existing GET/PUT /api/me/preferences pair via the
 * `hints` config key — no new API routes. Dismiss persists like every other
 * onboarding surface in this app (governance-tour.tsx, first-run-wizard.tsx):
 * usePreferences() already no-ops the PUT for the shared demo identity.
 */
export function PageHint({ seed }: { seed?: PrefsSeed | null } = {}) {
  const pathname = usePathname();
  // With `seed` (the console layout reads it on the server) the strip is in the
  // first paint; without it the strip waits for the preferences GET and pushes
  // the page down ~33px when it arrives.
  const { ready, config, update } = useSeededPreferences(seed);

  if (!ready) return null;

  const hint = hintFor(pathname);
  if (!hint) return null;
  if (isHintDismissed(config, hint.id)) return null;
  const docUrl = hintDocUrl(hint);

  function handleDismiss() {
    if (!hint) return;
    update(dismissHint(config, hint.id));
  }

  return (
    <div
      data-testid="page-hint"
      className="flex items-center gap-2 border-b border-border-subtle bg-sunken/60 px-4 py-2 text-xs text-ink-secondary"
    >
      <Info size={13} className="shrink-0 text-ink-muted" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {hint.text}
        {docUrl && (
          <>
            {" "}
            <a
              href={docUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring rounded text-accent hover:underline"
            >
              {hint.docLabel ?? "Learn more"}
            </a>
          </>
        )}
      </span>
      {/* F7 — 44px hit area via an invisible ::before pseudo-element centered
          on the button, so the slim one-line strip doesn't grow taller and
          the icon's visual size is unchanged. */}
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss hint"
        className="focus-ring relative shrink-0 rounded-md p-1 text-ink-muted hover:bg-canvas hover:text-ink before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
      >
        <X size={12} />
      </button>
    </div>
  );
}

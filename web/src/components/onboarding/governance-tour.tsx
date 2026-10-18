"use client";

import Link from "next/link";
import { CheckCircle2, X } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { useSeededPreferences } from "@/components/onboarding/use-seeded-preferences";
import type { PrefsSeed } from "@/lib/onboarding/seed";
import {
  tourItems,
  shouldShowTour,
  isVisited,
  markVisited,
  dismissTour,
} from "@/lib/onboarding/tour";

/**
 * Governance tour (L-50, R-77) — a compact dismissible card with 5 deep
 * links into the governance surfaces of the product. Mounted by
 * dashboard/page.tsx for EVERY role, including viewers (every link here is a
 * read surface — see recon-identity.md §5's verify-as-funnel-identity note,
 * which is why this component, unlike FirstRunWizard, has no canWrite gate
 * at all), whenever the workspace has at least one project (the wizard owns
 * the empty state; this owns the seeded/demo state).
 *
 * Persistence mirrors FirstRunWizard's pattern exactly: PUT
 * /api/me/preferences ONLY when GET said `demo: false`. A demo actor keeps
 * dismiss/visited state in local component state only and the card simply
 * re-shows on their next visit — the shared-demo-identity carve-out.
 *
 * No new API routes — this reads/writes only the existing
 * GET/PUT /api/me/preferences pair via the new whitelisted `tour` config key.
 *
 * First render: `seed` is the viewer's tour state as the SERVER read it, so the
 * card is in the server HTML (or correctly absent) instead of appearing after
 * the preferences GET and shoving the page down. Without a seed (server could
 * not resolve one) it still waits for the client store, as before.
 */

export function GovernanceTour({
  firstProjectHref,
  seed,
}: {
  firstProjectHref?: string;
  seed?: PrefsSeed | null;
}) {
  const prefs = useSeededPreferences(seed);

  // Derived from the shared prefs store (R-78) — see first-run-wizard.tsx's
  // matching comment. A failed GET yields an empty config (tour undefined),
  // and `shouldShowTour(undefined)` is already `true`, reproducing the old
  // catch block's "show the tour by default" fallback for free.
  const loaded = prefs.ready;
  const tour = prefs.config.tour;
  const visible = shouldShowTour(tour);

  function persist(next: typeof tour) {
    // Demo identity never persists preferences; the store already no-ops
    // the PUT for it (see the component doc comment above — mirrors D7's
    // wizard carve-out) and keeps the merge local for the rest of this visit.
    prefs.update({ tour: next });
  }

  function handleVisit(itemId: string) {
    persist(markVisited(tour, itemId));
  }

  function handleDismiss() {
    persist(dismissTour(tour));
  }

  if (!loaded || !visible) return null;

  const items = tourItems(firstProjectHref);

  return (
    <Card>
      <CardHeader>
        <CardTitle>See the governance in 2 minutes</CardTitle>
        {/* F7 — 44px hit area via an invisible ::before pseudo-element; the
            card header's visual size is unchanged. */}
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss governance tour"
          className="focus-ring relative rounded-md p-1 text-ink-muted hover:bg-well hover:text-ink before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
        >
          <X size={14} />
        </button>
      </CardHeader>
      <CardBody className="p-0">
        <ul className="divide-y divide-border-subtle">
          {items.map((item) => {
            const visited = isVisited(tour, item.id);
            return (
              <li key={item.id}>
                <Link
                  href={item.href}
                  onClick={() => handleVisit(item.id)}
                  className="focus-ring flex min-h-11 items-center gap-3 px-5 py-3 text-sm hover:bg-well"
                >
                  <span
                    className="flex h-5 w-5 shrink-0 items-center justify-center"
                    aria-hidden="true"
                  >
                    {visited ? (
                      <CheckCircle2 size={16} className="text-success-ink" />
                    ) : (
                      <span className="h-2 w-2 rounded-full border border-border-strong" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-ink">
                      {item.title}
                      {/* the tick is aria-hidden; say it in text too */}
                      {visited && <span className="sr-only"> (visited)</span>}
                    </span>
                    <span className="block truncate text-xs text-ink-muted">{item.caption}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}

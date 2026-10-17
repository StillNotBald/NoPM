"use client";

import { CheckCircle2, X } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { usePreferences } from "@/lib/prefs/use-preferences";
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
 */

export function GovernanceTour({ firstProjectHref }: { firstProjectHref?: string }) {
  const prefs = usePreferences();

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
    void prefs.update({ tour: next });
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
          className="relative rounded-md p-1 text-ink-muted hover:bg-sunken hover:text-ink before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
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
                <a
                  href={item.href}
                  onClick={() => handleVisit(item.id)}
                  className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-sunken"
                >
                  <span
                    className="flex h-5 w-5 shrink-0 items-center justify-center"
                    aria-hidden="true"
                  >
                    {visited ? (
                      <CheckCircle2 size={16} className="text-success-ink" />
                    ) : (
                      <span className="h-2 w-2 rounded-full border border-border-subtle" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-ink">{item.title}</span>
                    <span className="block truncate text-xs text-ink-muted">{item.caption}</span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}

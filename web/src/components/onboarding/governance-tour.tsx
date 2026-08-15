"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, X } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { apiGet, apiPut } from "@/lib/api-client";
import {
  tourItems,
  shouldShowTour,
  isVisited,
  markVisited,
  dismissTour,
  type TourState,
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

interface PreferencesGetResponse {
  config?: { tour?: TourState };
  demo: boolean;
}

export function GovernanceTour({ firstProjectHref }: { firstProjectHref?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(false);
  const [demo, setDemo] = useState(false);
  const [tour, setTour] = useState<TourState | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    apiGet<PreferencesGetResponse>("/api/me/preferences")
      .then((res) => {
        if (cancelled) return;
        const state = res.config?.tour;
        setDemo(res.demo);
        setTour(state);
        setVisible(shouldShowTour(state));
      })
      .catch(() => {
        // Fail-soft (GET failure is non-critical here) — show the tour by
        // default rather than silently hiding a discovery surface.
        if (!cancelled) setVisible(true);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function persist(next: TourState) {
    setTour(next);
    // Demo identity never persists preferences; local state only (see the
    // component doc comment above — mirrors D7's wizard carve-out).
    if (demo) return;
    void apiPut("/api/me/preferences", { config: { tour: next } }).catch(() => {
      // non-critical — the card still works for the rest of this visit
    });
  }

  function handleVisit(itemId: string) {
    persist(markVisited(tour, itemId));
  }

  function handleDismiss() {
    setVisible(false);
    persist(dismissTour(tour));
  }

  if (!loaded || !visible) return null;

  const items = tourItems(firstProjectHref);

  return (
    <Card>
      <CardHeader>
        <CardTitle>See the governance in 2 minutes</CardTitle>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss governance tour"
          className="rounded-md p-1 text-ink-muted hover:bg-sunken hover:text-ink"
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
                      <CheckCircle2 size={16} className="text-success" />
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

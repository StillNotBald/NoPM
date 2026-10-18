"use client";

import { useRef, type KeyboardEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";
import { LENS_META, MAINLINE_LENSES, type MainlineLens } from "@/lib/mainline/lenses";

/**
 * L-12 — the 3-lens switcher (Subway/Journal/Network — design-approved
 * naming from the 2026-06-10 backlog wave, sprint-log/2026-06-10_backlog-program).
 * Purely a URL-state control: it never fetches — the server page reads
 * `?lens=` straight off `searchParams` and renders the matching lens (same
 * "RSC reads the param, this pushes the URL" contract the dashboard filter
 * bar and register filter bar already use). Lens constants live in
 * @/lib/mainline/lenses (plain module) so the RSC page can import them too.
 */
export { MAINLINE_LENSES, lensCaption, type MainlineLens } from "@/lib/mainline/lenses";

export function LensSwitcher({ lens }: { lens: MainlineLens }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function go(next: MainlineLens) {
    const qs = new URLSearchParams(searchParams.toString());
    qs.set("lens", next);
    router.push(`${pathname}?${qs.toString()}`);
  }

  // WAI-ARIA tabs, manual activation: arrows only MOVE focus (a lens change is a
  // server round-trip, so it should be a deliberate Enter/Space/click).
  function onKeyDown(e: KeyboardEvent, index: number) {
    const last = MAINLINE_LENSES.length - 1;
    let next = -1;
    if (e.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (e.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next < 0) return;
    e.preventDefault();
    tabRefs.current[next]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Mainline lens"
      className="flex items-center rounded-lg border border-border-subtle bg-well p-0.5 gap-0.5 shrink-0"
    >
      {MAINLINE_LENSES.map((l, i) => {
        const meta = LENS_META[l];
        const active = l === lens;
        return (
          <button
            key={l}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`mainline-tab-${l}`}
            aria-selected={active}
            aria-controls="mainline-panel"
            tabIndex={active ? 0 : -1}
            title={`${meta.display} — ${meta.functional} lens`}
            onClick={() => go(l)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "focus-ring min-h-[44px] sm:min-h-[36px] rounded-md px-3 text-xs font-medium transition-all duration-200",
              active ? "bg-surface text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
            )}
          >
            {meta.display}
          </button>
        );
      })}
    </div>
  );
}

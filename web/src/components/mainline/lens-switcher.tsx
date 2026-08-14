"use client";

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

  function go(next: MainlineLens) {
    const qs = new URLSearchParams(searchParams.toString());
    qs.set("lens", next);
    router.push(`${pathname}?${qs.toString()}`);
  }

  return (
    <div
      role="tablist"
      aria-label="Mainline lens"
      className="flex items-center rounded-lg border border-border-subtle bg-sunken p-0.5 gap-0.5 shrink-0"
    >
      {MAINLINE_LENSES.map((l) => {
        const meta = LENS_META[l];
        const active = l === lens;
        return (
          <button
            key={l}
            type="button"
            role="tab"
            aria-selected={active}
            title={`${meta.display} — ${meta.functional} lens`}
            onClick={() => go(l)}
            className={cn(
              "min-h-[44px] sm:min-h-[36px] rounded-md px-3 text-xs font-medium transition-all duration-200",
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

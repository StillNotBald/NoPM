"use client";

import { useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useModal } from "@/components/ui/modal";
import { useMediaQuery, QUERY_MD_UP } from "@/lib/hooks/use-media-query";
import { cn } from "@/lib/cn";

/**
 * FilterSheet (F4) — collapses a register's filter row into one button below
 * `md` so a page's data isn't pushed 1,400px below the fold behind filters.
 *
 * At `md`+ this renders `children` inline, unchanged — existing filter rows
 * (search / status / priority / dates / group-by / columns / views / save
 * view) drop in exactly as they render today; no caller changes their markup.
 *
 * Below `md` it renders a single 44px "Filters" button with an active-count
 * badge that opens `children` in a Modal-based bottom sheet, with a sticky
 * "Apply / Clear" footer. `onApply`/`onClear` are optional — omit `onApply`
 * for callers whose filters already apply live as the caller's own state
 * changes (Apply then just closes the sheet).
 */
export function FilterSheet({
  activeCount,
  title = "Filters",
  onApply,
  onClear,
  children,
}: {
  activeCount: number;
  title?: string;
  onApply?: () => void;
  onClear?: () => void;
  children: ReactNode;
}) {
  // SSR/first paint renders the md+ (desktop) branch — matches this
  // codebase's existing convention of the inline filter row being the
  // pre-JS baseline, and avoids a mobile-first flash on desktop.
  const isDesktop = useMediaQuery(QUERY_MD_UP, true);
  const modal = useModal();
  const [sheetOpen, setSheetOpen] = useState(false);

  if (isDesktop) {
    return <div className="contents">{children}</div>;
  }

  function openSheet() {
    setSheetOpen(true);
    modal.open(children, {
      title,
      footer: (
        <div className="flex items-center gap-2">
          {onClear && (
            <Button
              type="button"
              variant="secondary"
              className="h-11 flex-1"
              onClick={() => {
                onClear();
              }}
            >
              Clear
            </Button>
          )}
          <Button
            type="button"
            variant="primary"
            className="h-11 flex-1"
            onClick={() => {
              onApply?.();
              modal.close();
              setSheetOpen(false);
            }}
          >
            Apply
          </Button>
        </div>
      ),
    });
  }

  return (
    <Button
      type="button"
      variant="secondary"
      onClick={openSheet}
      aria-expanded={sheetOpen}
      className="relative h-11 w-11 shrink-0 p-0 sm:h-11 sm:w-auto sm:px-3.5"
      aria-label={activeCount > 0 ? `${title} (${activeCount} active)` : title}
    >
      <SlidersHorizontal size={16} className="sm:mr-1.5" />
      <span className="hidden sm:inline">{title}</span>
      {activeCount > 0 && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full",
            "bg-accent px-1 font-mono text-2xs font-semibold leading-none text-accent-ink",
            "sm:static sm:ml-1.5 sm:-mr-0.5",
          )}
        >
          {activeCount}
        </span>
      )}
    </Button>
  );
}

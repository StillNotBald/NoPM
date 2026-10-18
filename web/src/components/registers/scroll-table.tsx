"use client";

import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Register table surface: a bordered, horizontally scrollable region that says
 * so. A table wider than its column scrolls INSIDE this box (never the page),
 * the box is keyboard-scrollable (focusable region with a name), and a soft
 * edge appears on whichever side still has content so the clipped columns are
 * discoverable instead of silently cut off.
 *
 * Use with the DataTable primitives (THead / TH / TR / TD):
 *
 *   <ScrollTable label="Risk register">
 *     <THead>…</THead><tbody>…</tbody>
 *   </ScrollTable>
 *
 * Cell horizontal padding is trimmed to 0.875rem here (the density token is
 * 1.25rem): a 9-column register otherwise spends ~360px of a 974px column on
 * padding alone. Vertical density still follows the global tokens.
 */
export function ScrollTable({
  label,
  bare = false,
  className,
  wrapperClassName,
  footer,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLTableElement>, "children"> & {
  /** Accessible name for the scroll region. */
  label: string;
  /** Skip the border/radius (the table sits inside a Card). */
  bare?: boolean;
  wrapperClassName?: string;
  /** Rendered inside the bordered surface, under the scroll region (e.g. AggregateFooter). */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const table = el.firstElementChild;
    if (table) ro.observe(table);
    return () => ro.disconnect();
  }, [measure]);

  return (
    <div
      className={cn(
        "min-w-0 max-w-full bg-surface",
        !bare && "rounded-lg border border-border-subtle",
        wrapperClassName,
      )}
    >
      <div className="relative">
        <div
          ref={scrollerRef}
          role="region"
          aria-label={label}
          tabIndex={0}
          onScroll={measure}
          className={cn("focus-ring-inset overflow-x-auto", !bare && (footer ? "rounded-t-lg" : "rounded-lg"))}
        >
          <table className={cn("w-full border-collapse text-sm [--cell-px:0.875rem]", className)} {...props}>
            {children}
          </table>
        </div>
        <Edge side="left" visible={edges.left} />
        <Edge side="right" visible={edges.right} />
      </div>
      {footer}
    </div>
  );
}

function Edge({ side, visible }: { side: "left" | "right"; visible: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-y-0 w-3 transition-opacity duration-150 print:hidden",
        side === "left"
          ? "left-0 shadow-[inset_10px_0_8px_-8px_color-mix(in_srgb,var(--np-fg)_22%,transparent)]"
          : "right-0 shadow-[inset_-10px_0_8px_-8px_color-mix(in_srgb,var(--np-fg)_22%,transparent)]",
        visible ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

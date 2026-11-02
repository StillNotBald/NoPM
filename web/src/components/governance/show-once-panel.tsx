"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * A secret the server will never show again (a new API token, a calendar
 * subscription link, 2FA backup codes). One pattern for all of them:
 *
 *  - it takes focus on mount (screen-reader and keyboard users land on it, and
 *    the browser scrolls it into view), and is scrolled into view explicitly so
 *    a panel that appears far from the button that made it is never off-screen
 *    on a phone;
 *  - the heading names it and the "shown once" notice is its description, so
 *    focusing the heading announces both;
 *  - it stays until the person says they have saved it. Dismissing runs
 *    `onDismiss` (callers drop the secret from state) and returns focus to
 *    `returnFocusTo()` when given.
 */
export function ShowOncePanel({
  heading,
  notice = "Shown once. Copy it now.",
  children,
  dismissLabel = "I've saved it",
  onDismiss,
  returnFocusTo,
  className,
}: {
  heading: string;
  notice?: string;
  children: ReactNode;
  dismissLabel?: string;
  onDismiss: () => void;
  /** Where focus goes after dismiss (the panel is about to unmount). */
  returnFocusTo?: () => HTMLElement | null;
  className?: string;
}) {
  const headingId = useId();
  const noticeId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // Focus first (without the browser's own scroll), then scroll the whole panel
    // into view so a panel mounted far from its trigger never lands off-screen
    // (scroll-mt clears the sticky header; `nearest` moves the page least).
    headingRef.current?.focus({ preventScroll: true });
    sectionRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, []);

  function dismiss() {
    onDismiss();
    // The panel unmounts on the next render; move focus once that has happened.
    if (returnFocusTo) requestAnimationFrame(() => returnFocusTo()?.focus());
  }

  return (
    <section
      ref={sectionRef}
      aria-labelledby={headingId}
      className={cn("scroll-mt-20 space-y-3 rounded-lg border border-border-subtle bg-well p-4", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* describedby sits on the heading itself: that is what takes focus, so the
            "shown once" notice is read with the name. */}
        <h4
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          aria-describedby={noticeId}
          className="text-sm font-medium text-ink focus:outline-none"
        >
          {heading}
        </h4>
        <Badge id={noticeId} tone="warning">
          {notice}
        </Badge>
      </div>
      {children}
      <Button type="button" variant="secondary" size="sm" className="h-11 w-full sm:h-8 sm:w-auto" onClick={dismiss}>
        {dismissLabel}
      </Button>
    </section>
  );
}

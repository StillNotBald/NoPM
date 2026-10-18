"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * Container for a secret the API returns exactly once (new token, calendar
 * feed link, 2FA backup codes, connector relay secret). It moves focus to its
 * heading on mount so keyboard and screen-reader users land on the secret
 * instead of being left on the (now disabled) button that created it, marks
 * the single-view nature with a warning badge, and ends in an explicit
 * acknowledge button that discards the secret from page state via `onDismiss`.
 *
 *   <ShowOncePanel title="Your subscription link" onDismiss={() => setUrl(null)}>
 *     <CopyValue label="Subscription URL" value={url} subject="subscription URL" />
 *   </ShowOncePanel>
 */
export function ShowOncePanel({
  title,
  children,
  onDismiss,
  dismissLabel = "I’ve saved it",
  notice = "Shown once — copy it now.",
  className,
}: {
  title: string;
  children: ReactNode;
  onDismiss: () => void;
  dismissLabel?: string;
  /** Text of the warning badge. */
  notice?: string;
  className?: string;
}) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section
      aria-labelledby={headingId}
      className={cn("space-y-3 rounded-lg border border-border-subtle bg-well p-4", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="text-sm font-medium text-ink focus:outline-none"
        >
          {title}
        </h4>
        <Badge tone="warning">{notice}</Badge>
      </div>
      {children}
      <Button type="button" variant="secondary" size="sm" className="w-full sm:w-auto" onClick={onDismiss}>
        {dismissLabel}
      </Button>
    </section>
  );
}

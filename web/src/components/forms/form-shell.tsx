import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Form layout primitives — turn the flat "journal" stack of fields into a
 * structured, Jira-style form: a main content column with an optional
 * right-hand properties rail, grouped into titled sections.
 *
 * Uses container queries (@container) so it adapts to the *panel* width, not
 * the viewport: single column in the narrow inspector, two columns when the
 * inspector is expanded.
 */
export function FormShell({
  main,
  aside,
  className,
}: {
  main: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  if (!aside) {
    return <div className={cn("@container space-y-6", className)}>{main}</div>;
  }
  return (
    <div className={cn("@container", className)}>
      <div className="grid grid-cols-1 gap-x-6 gap-y-6 @[34rem]:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="min-w-0 space-y-6">{main}</div>
        <aside className="space-y-4 @[34rem]:border-l @[34rem]:border-border-subtle @[34rem]:pl-5">
          {aside}
        </aside>
      </div>
    </div>
  );
}

/** A titled group of fields. The header gives the form scannable structure. */
export function FormSection({
  title,
  description,
  children,
  className,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      {title ? (
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
            {title}
          </h3>
          {description ? <p className="mt-0.5 text-xs text-ink-muted">{description}</p> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Responsive field grid: 1 column on narrow panels, 2 when there's room. */
export function FormGrid({
  children,
  cols = 2,
  className,
}: {
  children: ReactNode;
  cols?: 1 | 2;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-1 gap-3", cols === 2 && "@[26rem]:grid-cols-2", className)}>
      {children}
    </div>
  );
}

/** Sticky-feeling footer action row (Cancel / Save). */
export function FormActions({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 border-t border-border-subtle pt-3 sm:flex-row sm:justify-end",
        className,
      )}
    >
      {children}
    </div>
  );
}

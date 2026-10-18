import type { ReactNode } from "react";

/**
 * Page frame for the public pages: a skip link, the page's own header and
 * footer as landmarks, and a single `<main id="main">` around the body. Public
 * pages had no `<main>` at all (axe `landmark-one-main`, `region`), so a
 * keyboard or screen-reader visitor could not jump past the nav.
 *
 * The header/footer stay in each page because they differ (width, links);
 * the shell only owns the landmarks and the skip target.
 */
export function MarketingShell({
  header,
  footer,
  children,
}: {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      {/* Parked above the viewport, slides in on keyboard focus. (Not sr-only +
          not-sr-only: that pair depends on utility order to reach position:fixed.) */}
      <a
        href="#main"
        className="absolute left-4 top-2 z-[60] -translate-y-[200%] rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink focus:translate-y-0 focus-ring"
      >
        Skip to content
      </a>
      {header}
      <main id="main" tabIndex={-1} className="outline-none">
        {children}
      </main>
      {footer}
    </div>
  );
}

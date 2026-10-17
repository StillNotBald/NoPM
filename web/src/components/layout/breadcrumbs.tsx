"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { labelForSegment } from "@/lib/nav/nav-config";
import { useCrumbLabel } from "@/lib/nav/crumb-label";

type Crumb = { label: string; href?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Humanise an unmapped segment ("some-thing" -> "Some thing"); ids become "Details". */
function fallbackLabel(seg: string): string {
  if (UUID_RE.test(seg) || /^\d+$/.test(seg)) return "Details";
  const spaced = seg.replace(/[-_]+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : seg;
}

function useBreadcrumbs(): Crumb[] {
  const pathname = usePathname();
  const segments = (pathname ?? "").replace(/^\//, "").split("/").filter(Boolean);

  // /projects/[id] — the project page registers its own name (no list fetch).
  const projectId = segments[0] === "projects" && segments[1] ? segments[1] : null;
  const projectLabel = useCrumbLabel(projectId);

  if (!pathname || segments.length === 0) return [];
  // Hide breadcrumb bar on bare /dashboard (only crumb would be "NoPM")
  if (segments.length === 1 && segments[0] === "dashboard") return [];

  const crumbs: Crumb[] = [{ label: "NoPM", href: "/dashboard" }];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    const label =
      i === 1 && projectId
        ? (projectLabel ?? "Project")
        : (labelForSegment(seg) ?? fallbackLabel(seg));
    const href = isLast ? undefined : "/" + segments.slice(0, i + 1).join("/");
    crumbs.push({ label, href });
  }

  return crumbs;
}

export function Breadcrumbs() {
  const crumbs = useBreadcrumbs();

  // Nothing to show (e.g. bare /dashboard)
  if (crumbs.length === 0) return null;

  // Crumb links get a ~41px-tall hit area (the before: pseudo-element) on a 17px
  // label without growing the 36px bar.
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex h-9 shrink-0 items-center border-b border-border-subtle bg-canvas px-3 sm:px-4"
    >
      <ol className="flex min-w-0 items-center gap-1">
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <li key={i} className="flex items-center gap-1">
              {i > 0 && (
                <ChevronRight
                  size={12}
                  className="shrink-0 text-ink-muted"
                  aria-hidden
                />
              )}
              {crumb.href && !isLast ? (
                <Link
                  href={crumb.href}
                  className={cn(
                    "focus-ring relative rounded-sm font-mono text-[11px] text-ink-muted transition-colors hover:text-ink before:absolute before:inset-x-0 before:-inset-y-3 before:content-['']",
                    i === 0 && "text-accent hover:text-accent/80",
                  )}
                >
                  {crumb.label}
                </Link>
              ) : (
                <span
                  aria-current={isLast ? "page" : undefined}
                  className={cn(
                    "font-mono text-[11px]",
                    isLast ? "text-ink-secondary" : "text-ink-muted",
                  )}
                >
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

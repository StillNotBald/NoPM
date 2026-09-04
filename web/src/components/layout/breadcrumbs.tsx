"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { apiGet } from "@/lib/api-client";

// Route segment → human label
const SEGMENT_LABELS: Record<string, string> = {
  "my-work": "My Work",
  "my-tasks": "My Tasks",
  dashboard: "Dashboard",
  start: "Getting started",
  projects: "Projects",
  portfolio: "Portfolio",
  documents: "Documents",
  risks: "Risks",
  issues: "Issues",
  clashes: "Clashes",
  resources: "Resources",
  budget: "Budget",
  review: "Review",
  "change-control": "Change Control",
  decisions: "Decisions",
  approvals: "Approvals",
  trust: "Trust Center",
  tokens: "Tokens",
};

type Crumb = { label: string; href?: string };

type ProjectStub = { id: string; code?: string | null; name: string };

/** Derive a short display ID from a UUID (first 8 chars). */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function useBreadcrumbs(): Crumb[] {
  const pathname = usePathname();
  const [projectName, setProjectName] = useState<string | null>(null);

  // Detect /projects/[id] pattern
  const projectsMatch = pathname?.match(/^\/projects\/([^/]+)(?:\/.*)?$/);
  const projectId = projectsMatch?.[1] ?? null;

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    apiGet<ProjectStub[]>("/api/projects")
      .then((projects) => {
        if (cancelled) return;
        const match = projects?.find((p) => p.id === projectId);
        setProjectName(match?.code ?? match?.name ?? shortId(projectId));
      })
      .catch(() => {
        if (!cancelled) setProjectName(shortId(projectId));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (!pathname) return [];

  // Strip leading slash and split
  const segments = pathname.replace(/^\//, "").split("/").filter(Boolean);

  // Hide breadcrumb bar on bare /dashboard (only crumb would be "NoPM")
  if (segments.length === 1 && segments[0] === "dashboard") return [];

  const crumbs: Crumb[] = [{ label: "NoPM", href: "/dashboard" }];

  if (segments.length === 0) return [];

  // /projects/[id] — 2 levels deep
  if (segments[0] === "projects" && segments[1]) {
    crumbs.push({ label: "Projects", href: "/projects" });
    // Last crumb is plain text (no href)
    crumbs.push({
      label: projectName ?? shortId(segments[1]),
    });
    return crumbs;
  }

  // General case: map each segment
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const label = SEGMENT_LABELS[seg] ?? seg;
    const isLast = i === segments.length - 1;
    const href = isLast ? undefined : "/" + segments.slice(0, i + 1).join("/");
    crumbs.push({ label, href });
  }

  return crumbs;
}

export function Breadcrumbs() {
  const crumbs = useBreadcrumbs();

  // Nothing to show (e.g. bare /dashboard)
  if (crumbs.length === 0) return null;

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex h-9 shrink-0 items-center gap-1 border-b border-border-subtle bg-canvas/80 px-3 backdrop-blur-xl sm:px-4"
    >
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={i} className="flex items-center gap-1">
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
                  "font-mono text-[11px] text-ink-muted transition-colors hover:text-ink",
                  i === 0 && "text-accent hover:text-accent/80",
                )}
              >
                {crumb.label}
              </Link>
            ) : (
              <span
                className={cn(
                  "font-mono text-[11px]",
                  isLast ? "text-ink-secondary" : "text-ink-muted",
                )}
              >
                {crumb.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}

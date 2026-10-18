/**
 * Mainline lens constants (L-12) — a PLAIN shared module, deliberately not
 * "use client": the server page (mainline/page.tsx) reads MAINLINE_LENSES /
 * lensCaption for URL-param validation, and importing non-component values
 * from a "use client" module into an RSC yields client-reference proxies,
 * not the real values (MAINLINE_LENSES.includes throws at runtime — the
 * adversarially-verified F2a crash). Both the RSC page and the client
 * LensSwitcher import from here.
 */

export type MainlineLens = "portfolio" | "project" | "dependency";

export const MAINLINE_LENSES: MainlineLens[] = ["portfolio", "project", "dependency"];

export const LENS_META: Record<MainlineLens, { display: string; functional: string; caption: string }> = {
  portfolio: {
    display: "Subway",
    functional: "Portfolio",
    caption: "Every project as a lane, milestones and tasks on one time axis.",
  },
  project: {
    display: "Journal",
    functional: "Project",
    caption: "One project's milestones, tasks and dependency edges — baseline vs actual when locked.",
  },
  dependency: {
    display: "Network",
    functional: "Dependency",
    caption: "The cross-project task dependency graph — critical path highlighted.",
  },
};

export function lensCaption(lens: MainlineLens): string {
  return LENS_META[lens].caption;
}

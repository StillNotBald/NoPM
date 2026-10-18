# Mobile UI audit — baseline (2026-09-07)

Method: Playwright against a local dev server, demo account (read-only, nothing submitted), 29 routes × two viewports (iPhone 14 390×844 DPR 3; small Android 360×800 DPR 2.5), plus panel/board/Gantt/modal interactions. Raw measurements in `results.json`, `supplement-*.json`; screenshots in `baseline/<viewport>/` (PNGs are gitignored per the testing-log contract and regenerable with `audit.mjs`; the summaries here and in `COMPARISON.md` are the evidence). Script: `audit.mjs`. The audit agent could not write this file itself; the lead compiled it from the agent's report and a manual read of the screenshots.

Note: the dark round "N" button at bottom-left in every dev screenshot is the Next.js dev-tools indicator, not NoPM UI. It does not exist in production builds. Ignore it.

## Headline

No page produces horizontal document overflow on either viewport; all 14 wide tables sit in `overflow-x-auto` wrappers; Kanban and Gantt scroll by touch. The earlier mobile hardening pass holds. The remaining problems are usability, not layout breakage: sheets that do not lock the page behind them, sub-44px controls, filter stacks that push content below the fold, and a few clipped form controls.

## Summary (both viewports unless noted)

| Check | Result |
|---|---|
| Document horizontal overflow | none on 29/29 pages |
| Wide tables without scroll wrapper | 0 of 14 |
| Kanban / Gantt touch-scroll | works |
| Panels (RightPushPanel) on mobile | full-screen sheet, body scroll NOT locked, background not inert |
| Modal on mobile | same as panels |
| Close buttons on sheets | 32×32 px (below the 44 px rule the codebase already enforces on header buttons) |
| Bottom nav | present, safe-area padded, does not cover content |
| Login | inputs full width, demo button visible without scrolling |
| Landing | readable, CTAs ≥ 44 px, nav collapses |

## Ranked findings

| ID | Severity | Where | What | Fix |
|---|---|---|---|---|
| F1 | Blocker | `components/ui/right-push-panel.tsx`, `components/ui/modal.tsx` | Sheets never lock body scroll or mark the app shell inert; touch and screen-reader users can interact with the page behind an open sheet | shared scroll-lock + inert hook below `lg`, applied to both |
| F2 | Major | same files (close button) | Close button is `h-8 w-8` (32 px); it is the only way out of a full-screen sheet | `h-11 w-11`, sticky sheet header |
| F3 | Major | `components/dashboard/*` filter row (see `baseline/iphone/dashboard.png`) | The Project `<select>` extends past the viewport edge (clipped, not scrollable); date-range pair is cramped | `min-w-0 w-full` on grid children; stack the range on `<sm` |
| F4 | Major | `/tasks`, `/risks`, `/issues`, `/clashes`, `/documents`, `/timesheets`, `/resources` (see `baseline/iphone/tasks.png`) | Filter controls (search, status, priority, dates, group-by, columns, views, save view) fill the first ~1,400 px before any data is visible | `FilterSheet` primitive: on `<md` collapse into one "Filters (n)" button opening a bottom sheet; inline on `≥md` |
| F5 | Major | every register table on `<md` | Tables clip to 3–4 columns and truncate values (`2026-08-1…`); horizontal scroll is available but discoverable only by accident | `DataList` primitive: card rows on `<md` (title + badges + two key fields), table on `≥md` |
| F6 | Minor | `components/dashboard/export-board-pack.tsx:74-89` | Format chevron 36×32 px | 44 px hit area |
| F7 | Minor, recurring | `components/onboarding/page-hint.tsx:57-64`, `governance-tour.tsx:67-73` | Dismiss buttons ~20 px, present on nearly every page | 44 px hit area (padding/negative margin, visual size unchanged) |
| F8 | Minor, systemic | `mainline/portfolio-lens.tsx` (84 nodes), `portfolio/roadmap.tsx`, `portfolio/program-rollup-card.tsx`, `my-work/hot-strip.tsx`, `ui/severity.tsx`, `tracking/gantt.tsx`, `registers/risk-heatmap.tsx` | Literal `text-[8px]`/`[9px]`/`[10px]` | one `text-2xs` token (11 px on `<md`, 10 px on `≥md`) and a source-scan test forbidding new literals |
| F9 | Minor | project detail header (see `baseline/iphone/projects_detail.png`) | "Request deletion" wraps to two lines beside three other actions | overflow menu for secondary actions on `<sm` |
| F10 | Not a bug | all register pages | `text-xs` (12 px) density is the deliberate terminal aesthetic | keep; recorded so it is not re-flagged |

False positives in the automated tiny-tap scan (ignore): RightPushPanel's close button when the panel is closed (mounted off-screen); the tokens page scope checkboxes (wrapped in a `min-h-[44px]` label).

Not confirmed: the generic panel-opener selector found no trigger on `/tasks` and the project Board tab (task rows open via a link, not `tr[role=button]`); panel behaviour on those pages is assumed identical to `/risks` and `/issues`, which were measured.

## Mobile shell spec (for the shared-components worker)

- Breakpoints: `<md` (768) is "phone", `md–lg` is "tablet", `≥lg` keeps the sidebar.
- Sheets: full-screen below `md`, bottom-sheet style (top radius, drag affordance optional) between `md` and `lg`; sticky header with 44 px close; sticky footer for primary actions; body scroll locked and app shell `inert` while open; `Escape` and swipe-down close; return focus to the opener.
- Tap targets: 44×44 CSS px minimum for every interactive element; hit area may exceed the visual box.
- Type: floor 11 px on phones via `text-2xs`; `text-xs` stays 12 px; no new literal sub-12 px classes.
- Tables: `DataList` renders cards below `md` (primary text, up to three chips, two secondary fields, chevron), table above; pages keep their column definitions.
- Filters: `FilterSheet` collapses filter rows into one button with an active-count badge below `md`.
- Forms: every control `w-full min-w-0`; date ranges stack below `sm`; primary submit sticky at the bottom of sheets.
- Headers: title + one primary action inline; secondary actions in an overflow menu below `sm`.
- Safe areas: `env(safe-area-inset-*)` on the bottom nav, sheet footers, and toasts.

## Page-group assignment (parallel workers after the shell lands)

| Group | Pages | Component folders |
|---|---|---|
| registers | /risks, /issues, /clashes, /documents, /decisions, /change-control, /baselines | `components/registers`, `components/documents`, `components/decisions`, `components/change-control`, `components/baselines` |
| tracking | /projects, /projects/[id] (tabs), /tasks, /my-tasks, /my-work, /mainline, /portfolio, /dashboard | `components/tracking`, `components/kanban`, `components/mainline`, `components/portfolio`, `components/dashboard`, `components/my-work`, `components/my-tasks` |
| resources | /resources, /timesheets, /budget, /sprints | `components/resources`, `components/timesheets`, `components/budget`, `components/sprints` |
| governance | /trust, /approvals, /review, /tokens, /settings, /email-previews, /start | `components/review`, `components/trust`, `app/(console)/tokens`, `app/(console)/settings`, `components/onboarding` |
| marketing | /, /case-study, /login | `app/page.tsx`, `app/case-study`, `app/login`, `components/marketing` |

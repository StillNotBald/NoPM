# Mobile shell primitives (R-94) — report

Built the shared mobile foundation the audit in `testing-log/2026-09-07_mobile-ui/FINDINGS.md` called for (F1-F9), for the page-group workers to adopt next.

## Files

New:
- `web/src/lib/hooks/use-sheet.ts` — `useBodyScrollLock(open)`, `useInertShell(open)`, `useReturnFocus(open, initialFocusRef?, explicitOpenerRef?)`
- `web/src/lib/hooks/use-media-query.ts` — `useMediaQuery(query, defaultValue?)` + breakpoint constants (`QUERY_BELOW_SM/MD/LG`, `QUERY_MD_TO_LG`, `QUERY_MD_UP`, `QUERY_LG_UP`)
- `web/src/components/ui/filter-sheet.tsx` — `FilterSheet`
- `web/src/components/ui/data-list.tsx` — `DataList`
- `web/src/components/ui/MOBILE.md` — adoption doc for page workers
- `web/src/lib/hooks/use-sheet.test.ts`, `web/src/lib/hooks/use-media-query.test.ts`

Edited:
- `web/src/components/ui/right-push-panel.tsx` — hooks wired in, three-tier responsive shell, 44px close, footer slot
- `web/src/components/ui/modal.tsx` — hooks wired in, footer slot, escape/focus management, 44px close
- `web/src/components/layout/app-shell.tsx` — added the `data-app-shell` region
- `web/src/components/layout/mobile-chrome.test.ts` — extended with 4 new describe blocks
- `web/src/components/ui/page-header.tsx` — `secondaryActions` + overflow menu
- `web/src/components/ui/input.tsx` — uses the new `field` utility
- `web/src/app/globals.css` — `text-2xs` and `field` utilities
- `web/src/components/ui/severity.tsx`, `entity-link.tsx`, `layout/project-switcher.tsx`, `notifications/bell.tsx` — `text-[8|9|10px]` literals replaced with `text-2xs`
- `web/src/components/notifications/bell.tsx` — mobile sheet adopts the hooks + gets a 44px close button
- `web/src/components/onboarding/page-hint.tsx`, `governance-tour.tsx`, `web/src/components/dashboard/export-board-pack.tsx` — 44px hit areas via an invisible `::before` pseudo-element (visual size unchanged)

## API summary

**`useBodyScrollLock(open)`** / **`useInertShell(open)`** (`lib/hooks/use-sheet.ts`) — both gate themselves to below `lg` internally, so any caller can call them unconditionally; both are reference-counted at module scope so a Modal opened from inside an already-open RightPushPanel doesn't undo the lock/inert state until the outer one also closes. `useInertShell` targets `[data-app-shell]`, the attribute now on the wrapper in `app-shell.tsx` around sidebar + header + content + bottom nav — CommandPalette, RightPushPanel, and AssistantPanel render outside that wrapper so a sheet never inerts itself.

**`useReturnFocus(open, initialFocusRef?, explicitOpenerRef?)`** — not explicitly named in the brief but added for the third requirement ("move focus into the sheet on open, return to the opener on close"), shared by RightPushPanel, Modal, and the notification bell's mobile sheet. Captures `document.activeElement` at open (or `explicitOpenerRef` if given), focuses `initialFocusRef` (the close button) on open, restores the captured element on close.

**`FilterSheet`** (`{ activeCount, title?, onApply?, onClear?, children }`) — at `md`+ renders `children` inline unchanged (`<div className="contents">`), so existing filter rows drop in with zero markup changes. Below `md` it's a 44px button with an active-count badge opening `children` in a Modal-based bottom sheet with a sticky Apply/Clear footer.

**`DataList<T>`** (`{ columns, rows, rowKey, onRowClick?, href?, empty?, renderCard?, tableClassName? }`) — `columns: { key, header, cell(row), primary?, badge?, hideOnMobile?, align? }[]`. Renders a `<table>` at `md`+ (class signature copied from `change-table.tsx` — `overflow-x-auto` wrapper, `divide-y divide-border-subtle` body, `px-5 py-3`/`py-3.5` cells) and a card `<ul>` below `md` (primary column as title, `badge` columns as chips, next two non-primary/non-badge columns as label/value pairs, chevron when clickable). `onRowClick` takes priority over `href` (client-side `router.push`) when both are given.

**`PageHeader`** gained `secondaryActions?: ReactNode[]`, fully additive — all 26 existing call sites pass only `title`/`action` and render byte-identical to before. When passed, they render inline at `sm`+ and collapse into a 44px "More" overflow popover below `sm`.

## Verified live (Playwright, 390×844, `/risks`, demo login, read-only)

Confirmed via `document.activeElement`/`getBoundingClientRect`/`body.style` probes, before and after Escape:
- Opening a risk row: `body.style.position` → `fixed` (scroll-locked), `[data-app-shell]` gets `inert` + `aria-hidden="true"`, close button is exactly 44×44, focus moves to the close button.
- Escape: panel closes, lock/inert both clear, focus returns to the R-006 row that opened it.

Screenshot: `testing-log/2026-09-07_mobile-ui/after-shell/risks_panel.png`.

Note: the dev server 403'd its own JS chunks and hung on `127.0.0.1`; had to drive the browser against `localhost:3111` instead (unrelated to this change — looks like Next 16's dev-origin allowlist).

## Tests

`npx vitest run`: 2016 passed / 90 files (was 2000ish before; net new: 6 in `mobile-chrome.test.ts`'s new blocks + 4 in `use-media-query.test.ts` + 6 in `use-sheet.test.ts`, all source-scanning since **jsdom is not installed and this project disallows new dependencies without asking** — DataList's card-vs-table rendering is asserted via source-scan of the conditional class gates (`hidden overflow-x-auto md:block` / `divide-y divide-border-subtle md:hidden`) rather than a mounted-DOM assertion; said so rather than silently skipping it. `useMediaQuery` itself is likewise untestable without jsdom — tested instead: the breakpoint query constants (pure data) and a source-scan pinning its SSR-safe shape (`useState(defaultValue)`, no `matchMedia` read outside the effect).

`npx tsc --noEmit`: clean. `npx eslint` (scoped + full repo): clean except one pre-existing unrelated warning in `openrouter.test.ts` (not touched by this work).

## Remaining `text-[8|9|10px]` literals outside my scope

F8 named `mainline/portfolio-lens.tsx`, `portfolio/roadmap.tsx`, `my-work/hot-strip.tsx`, `tracking/gantt.tsx`, `registers/risk-heatmap.tsx` explicitly; the full current list (source-scanned, `web/src` root) for whoever widens the test glob:

```
app/(console)/dashboard/page.tsx
components/assistant/panel.tsx
components/assistant/setup.tsx
components/change-control/change-detail.tsx
components/command-palette.tsx
components/dashboard/project-dossier.tsx
components/dashboard/rag-donut-card.tsx
components/decisions/decision-detail.tsx
components/documents/document-viewer.tsx
components/documents/documents-client.tsx
components/mainline/portfolio-lens.tsx
components/my-tasks/task-list.tsx
components/my-work/hot-strip.tsx
components/my-work/task-row.tsx
components/portfolio/roadmap.tsx
components/registers/issue-detail.tsx
components/registers/risk-detail.tsx
components/registers/risk-heatmap.tsx
components/review/inline-action.tsx
components/review/queue-list.tsx
components/tracking/activity-table.tsx
components/tracking/charter-section.tsx
components/tracking/gantt.tsx
components/tracking/project-tabs.tsx
```

`components/ui/**` and `components/layout/**` are now completely clean (`severity.tsx`, `entity-link.tsx`, `project-switcher.tsx` fixed) and covered by a permanent regression test in `mobile-chrome.test.ts`; `notifications/bell.tsx` (in my file scope, not in the F8 list) was fixed too since it was a trivial two-spot change.

## Anything unverified

- FilterSheet and DataList are built and unit-tested but not yet wired into a real page (that's the page-group workers' job per the assignment) — I could not do a live Playwright check of their actual mobile rendering; I did verify their source against the spec and the existing `change-table.tsx` class signature by hand.
- Modal's mobile sheet (as opposed to RightPushPanel's) was not live-verified in the browser — only RightPushPanel (via `/risks`) and the notification bell were. Modal's lock/inert wiring is identical code (same two hooks), and its own unit tests in `mobile-chrome.test.ts` pass, but I'd flag it as a good target for one live check when a page worker first opens a Modal-based sheet on mobile.
- Nested-sheet reference counting (e.g. opening a Modal from inside an open RightPushPanel) is unit-tested via source-scan only — not exercised live, since no current page opens a Modal from inside the inspector panel.

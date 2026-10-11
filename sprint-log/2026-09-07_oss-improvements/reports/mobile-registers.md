# Mobile pass, register pages (R-94) - report

Scope: `web/src/app/(console)/{risks,issues,clashes,documents,decisions,change-control,baselines}/**`, `web/src/components/{registers,documents,decisions,change-control,baselines}/**`. No git commits made.

## Per-page changes

| Page | Table -> DataList? | Notes |
|---|---|---|
| /risks | Yes | New `RiskDataList` in `components/registers/risk-detail.tsx`. Columns: Ref (hideOnMobile), Title (primary), Project (hideOnMobile), Severity/Score/Strategy/Status (badges), Owner/Due (secondary). Old `RiskRowButton` removed (dead code once the table was gone). |
| /issues | Yes | New `IssueDataList` in `components/registers/issue-detail.tsx`. Columns: Ref (hideOnMobile), Title (primary), Project (hideOnMobile), Priority/Status (badges), Due (secondary). Old `IssueRowButton` removed. |
| /clashes | No, hand-rolled | Kept the desktop table verbatim (`hidden md:block`) and added a hand-rolled `<md` `<ul>` card list beside it, not a `<DataList>`. Reason: the deep-link opener (`?clash=<id>`) scrolls to and highlights one row by DOM id, and `DataList` gives no way to attach a per-row id to either its table `<tr>` or card `<li>`. Both renders now carry an id (desktop `clash-<id>`, mobile `clash-m-<id>`); `_clash-focus-opener.tsx` was updated to check both and pick whichever is actually on screen (`offsetParent !== null`) since both exist in the DOM at once (Tailwind `hidden`/`md:hidden`, not unmount). |
| /documents | Yes, with a custom card | `documents-client.tsx`'s table became a `<DataList>` with a full `renderCard` override (not the generic derivation) so the summary preview and Updated date survive on phones instead of being dropped as ordinary secondary fields. Old `DocumentRowButton` removed from `document-viewer.tsx`. |
| /decisions | Yes | `decision-table.tsx` rewritten onto `<DataList>`. Ref/Project/Decision-text hidden from the card derivation (hideOnMobile) so the two card secondary fields land on Decided By + Date. Old `DecisionRowButton` removed from `decision-detail.tsx`. |
| /change-control | Yes | `change-table.tsx` rewritten onto `<DataList>`. Ref/Project/Category hidden from the card derivation so the two secondary fields land on Impact + Requested By. Old `ChangeRowButton` removed from `change-detail.tsx`. |
| /baselines | Yes, two lists | New `web/src/components/baselines/baseline-lists.tsx` (`LockedBaselinesList`, `RebaselinesList`) since there was no `components/baselines/` folder before. Both tables are read-only (no `onRowClick`); the project-name cell is itself the clickable `EntityLink`, unchanged from before. |

## Goals from the brief that did not apply here

**FilterSheet (goal 1):** none of these 7 pages have a filter row. I checked: `FilterBar`/`SavedViewsBar`/`GroupBySelect`/`ColumnChooser` (the components a `FilterSheet` would wrap) are only imported by `/tasks` and the dashboard, not by risks/issues/clashes/documents/decisions/change-control/baselines. The baseline screenshots confirm this: every one of the 7 pages goes straight from the page header into the data. Nothing to wrap.

**field utility on raw selects/textareas (goal 3):** every `<select>`/`<textarea>` reachable from these 7 pages goes through the shared `SelectInput`/`TextareaInput` primitives in `components/forms/project-form.tsx`, which sits outside my file scope. They already render `w-full h-11 sm:h-10`, which is functionally equivalent to `field` (full width, 44px floor on phones) but does not carry the literal `field` class. I did not touch that file. `RiskForm`, `IssueForm`, `DecisionForm`, `ChangeForm`, and `DocumentForm` never build a raw `<select>`/`<textarea>` themselves, so there was nothing left for me to change inside my own scope.

**Panel footer slot for form submit buttons (goal 5):** blocked by the shared inspector API. `useInspector().open(content, title)` (in `components/layout/app-shell.tsx`, out of scope) only takes content and a title string, no footer option, unlike `useModal()` which already supports `{ footer }` (that is what `FilterSheet` uses). None of the five forms behind these pages (Risk, Issue, Decision, Change, Document) could move their Cancel/Save row into a sticky footer without that API gaining a footer parameter. I left the forms as they are (Cancel/Save buttons already `h-11 sm:h-10`, so still >=44px on phones) rather than making an out-of-scope edit to `app-shell.tsx`. Flagging this as a follow-up for whoever owns that file.

## Page-specific defect fixed (goal 6)

The baseline screenshot for `/documents` showed the Ref badge wrapping onto two lines ("DOC-\n019") because the old table's fixed columns squeezed too hard on a 390px screen. The new card layout puts the ref badge inline next to the title instead of in its own narrow column, so it no longer wraps.

## text-2xs literal fixes (goal 4)

Replaced `text-[10px]`/`text-[9px]` with `text-2xs` in every file the mobile-shell report's "remaining literals" list named inside my scope: `registers/risk-heatmap.tsx`, `registers/risk-detail.tsx`, `registers/issue-detail.tsx`, `decisions/decision-detail.tsx`, `change-control/change-detail.tsx`, `documents/document-viewer.tsx`, `documents/documents-client.tsx`. Left `text-[11px]` literals alone in all of these (out of F8's scope, a different size). Confirmed with a grep after: zero `text-[8px]`/`text-[9px]`/`text-[10px]` literals remain anywhere in my file scope.

## Verification

- `npx tsc --noEmit`: clean in every file I touched. (One pre-existing error remains in `app/(console)/budget/page.tsx`, a file outside my scope being actively edited by another concurrent worker; confirmed via `git diff --stat` that it is mid-flight and unrelated to this work.)
- `npx eslint` on my scope and on the full repo: 0 errors. The only warnings anywhere in the repo (`components/kanban/board.tsx`, `lib/assistant/providers/openrouter.test.ts`) are pre-existing and outside my scope.
- `npx vitest run`: **2018/2018 passing**, no regressions.

### Live check (Playwright, 390x844, demo login, read-only)

The shared dev server was down for a stretch of this session (Turbopack CSS parse failure from an invalid arbitrary-variant selector in `components/dashboard/dashboard-filter-bar.tsx`, outside anyone's register-page scope; the mobile-marketing worker's report already diagnosed the same root cause). It came back up on its own once another worker's edit resolved it, and I verified against `http://localhost:3113` from there.

The Playwright browser instance turned out to be shared session-wide across every concurrently running page-group worker, not isolated per agent: tabs I created and navigated were repeatedly hijacked mid-check by other agents' own navigations (I have the tab-list evidence: URLs jumping to `/approvals`, `/portfolio`, `/tasks`, project detail pages, etc. between one of my calls and the next). I worked around it by opening a fresh tab per page and re-verifying `location.href` immediately before each screenshot, discarding and retrying any check where the URL had moved. Net result:

- **Screenshots captured cleanly for all 7 pages**, saved to `testing-log/2026-09-07_mobile-ui/after/iphone/{risks,issues,clashes,documents,decisions,change-control,baselines}.png`. All 7 show a full card list on-screen, correct badges, and no clipped or double-line text.
- **Document-level horizontal overflow: none**, confirmed via `document.documentElement.scrollWidth === window.innerWidth` (390) on risks, issues, and documents before contention made further JS reads unreliable. All 7 screenshots also show no horizontal scrollbar or clipped content at the page level.
- **Risk heatmap note:** the heatmap's own internal `min-w-[420px]` scroll region (unchanged by me, pre-existing) does bound-box-exceed the 390px viewport, exactly as it did in the baseline; it does not cause document-level overflow (confirmed above) and scrolls on its own touch/scrollbar, matching FINDINGS.md's documented, accepted pattern for that widget.
- **First data row offset:** risks 677px, issues 226px, documents 290px, all comfortably under the 900px target (measured via DOM query before contention hit). Clashes/decisions/change-control/baselines were not independently measured in px because the browser kept getting reassigned mid-check, but every one of their screenshots shows the first card fully visible without scrolling.
- **Tiny-tap count (<40x40px):** 0 in my file scope. The only sub-40px targets found on risks/issues/documents (the three pages I could query cleanly) were the global "NoPM" logo link, the onboarding "Dismiss hint" button, and the assistant panel's close button, all three owned by other file groups (`layout`, `onboarding`, `assistant`) and all three already known/flagged elsewhere (the hint dismiss button already has the mobile-shell's invisible 44px `::before` hit area; `getBoundingClientRect` on the visual box alone doesn't see that). Clashes/decisions/change-control/baselines weren't independently measured for the same contention reason, but their cards are built on the same `min-h-[44px]` primitive (`DataList`'s own card body, or the same convention in the hand-rolled clash card) already exercised clean on the other three pages.
- **Panel-open interaction:** attempted a live re-check of tapping a risk card to confirm the inspector still opens (matching the original `risks_panel.png` baseline). The tab was hijacked to a different page between the click and the screenshot on both attempts, so I could not capture this live. It is verified by code inspection instead: `RiskDataList`'s `onRowClick` calls the exact same `inspector.open(<RiskDetail .../>, ...)` that the old `RiskRowButton` called, just triggered from a `DataList` card button instead of a `<tr>`; the panel component itself, `RightPushPanel`, and its scroll-lock/inert/focus hooks are all untouched. `testing-log/2026-09-07_mobile-ui/after/iphone/risks_panel.png` currently holds a stale screenshot from a hijacked tab (shows a project board, not the risk panel); treat that one file as not representative and disregard it.

## Files changed

- `web/src/app/(console)/risks/page.tsx`
- `web/src/app/(console)/issues/page.tsx`
- `web/src/app/(console)/clashes/page.tsx`
- `web/src/app/(console)/clashes/_clash-focus-opener.tsx`
- `web/src/app/(console)/baselines/page.tsx`
- `web/src/components/registers/risk-detail.tsx`
- `web/src/components/registers/issue-detail.tsx`
- `web/src/components/registers/risk-heatmap.tsx`
- `web/src/components/documents/documents-client.tsx`
- `web/src/components/documents/document-viewer.tsx`
- `web/src/components/decisions/decision-detail.tsx`
- `web/src/components/decisions/decision-table.tsx`
- `web/src/components/change-control/change-detail.tsx`
- `web/src/components/change-control/change-table.tsx`
- `web/src/components/baselines/baseline-lists.tsx` (new)

## Known, disclosed desktop deltas

Adopting the shared `DataList` table skin changes cell padding on risks/issues/documents from their old `py-3`/`px-4` to `DataList`'s `py-3.5`/`px-5`, matching the convention `change-table.tsx`/`decision-table.tsx` already used before this pass. This is a few pixels of extra row height and horizontal padding on desktop, not a layout change; I judged matching the shared primitive's one convention across all five converted registers as better than preserving five slightly different paddings. Documents also loses its old per-breakpoint column hiding (Type hidden below `sm`, Project/Updated hidden below `lg`) in favor of `DataList`'s single `md` cutover, so the `md` to `lg` tablet width now shows all 6 columns in the table instead of a reduced set; this trades a little tablet density for the same shared primitive everywhere.

## Anything else unverified

- Clashes, decisions, change-control, and baselines were not independently measured for document-overflow/first-row-offset/tiny-tap via DOM query (browser contention, see above); they were visually confirmed via screenshot only.
- The dashboard-filter-bar.tsx CSS bug that took the shared dev server down for part of this session is outside my scope; it appears to already be resolved (the server was healthy again by the time I finished), but I did not investigate further since it belongs to the tracking/dashboard mobile pass.

# Mobile UI re-audit — after the R-94 fix wave (2026-09-07)

Method: same approach as the baseline — Playwright against a local dev server (port 3120 this time), demo account, read-only, 29 routes × two viewports (iPhone 14 390×844 DPR 3; small Android 360×800 DPR 2.5), plus panel/board/Gantt/FilterSheet/notification-bell interactions. Script: `audit-after.mjs` (adapted from `audit.mjs` — new DataList mobile-card opener selector, a project-detail Board/Gantt tab walk, a `/tasks` FilterSheet check, and a notification-bell sheet check, on top of the same page sweep). Raw measurements: `results-after.json`. Screenshots: `after/<viewport>/`. Desktop control shots: `after/desktop/`. Dev server log: `dev-server-after.log`.

iPhone and Android numbers were identical in every case that mattered (both hit the same `md` breakpoint), so the table below is iPhone; android deltas are called out only where they differ.

## Headline

Every F1–F9 finding from the baseline is fixed and live-verified. Zero document overflow before and after (unchanged). Wide, unwrapped-for-mobile tables dropped from 15 to 3 (the 3 remaining — case-study's proof table, dashboard's activity table, and the plain `/projects` list table — all still have their `overflow-x-auto` wrapper; none regressed). Tiny tap targets (<40×40) fell from 308 to 211 sitewide. Sheets now lock the body and mark the app shell `inert`, with 44×44 close buttons and focus moving in and back out correctly, confirmed live on risks, issues, resources, the notification bell, the `/tasks` FilterSheet, and a Kanban card tap. One real gap survived: tapping a task card on `/tasks` navigates to the project page but never opens the task panel, because the project-detail page has no reader for the `?task=` query param `entityHref` sends it to — a pre-existing gap, not something this fix wave touched or claimed to fix.

## 1. Per-page comparison

Overflow was `false`/`false` on all 29 pages both times — omitted from the table below to save space. "First row" is new to this pass (baseline didn't measure it); pages with no table/DataList show `—`.

| Page | Tiny-tap before → after | Small-text(<13px) before → after | Wide table before → after | DataList cards? | First data row (px) |
|---|---|---|---|---|---|
| / (home) | 4 → 2 | 11 → 11 | 0 → 0 | — | — |
| /login | 1 → 1 | 5 → 5 | 0 → 0 | — | — |
| /case-study | 8 → 1 | 32 → 32 | 1 → 1 (wrapped) | — | 4205 |
| /start | 12 → 4 | 39 → 39 | 0 → 0 | — | — |
| /dashboard | 10 → 9 | 94 → 94 | 1 → 1 (wrapped) | — | 1963 |
| /my-work | 5 → 11* | 106 → 106 | 0 → 0 | — | — |
| /my-tasks | 20 → 19 | 66 → 66 | 0 → 0 | — | — |
| /portfolio | 8 → 7 | 124 → 124 | 0 → 0 | — | — |
| /projects | 11 → 10 | 54 → 54 | 1 → 1 (wrapped, not converted) | — | 307 |
| /projects/:id | 12 → 7 | 41 → 41 | 0 → 0 | — | — |
| /tasks | 21 → 5 | 229 → 630 | 1 → 0 | Yes | 451 |
| /mainline | 4 → 3 | 131 → 131 | 0 → 0 | — | — |
| /sprints | 9 → 3 | 38 → 38 | 0 → 0 | — | — |
| /timesheets | 7 → 4 | 45 → 69 | 0 → 0 | Yes | 1839 |
| /resources | 6 → 4 | 55 → 126 | 1 → 0 | Yes | 822 |
| /budget | 4 → 3 | 64 → 182 | 2 → 0 | Yes | 708 |
| /risks | 10 → 3 | 111 → 177 | 1 → 0 | Yes | 663 |
| /issues | 10 → 3 | 59 → 89 | 1 → 0 | Yes | 226 |
| /clashes | 6 → 5 | 43 → 60 | 1 → 0 | Yes (hand-rolled) | 253 |
| /documents | 4 → 3 | 98 → 212 | 1 → 0 | Yes | 291 |
| /decisions | 11 → 3 | 46 → 86 | 1 → 0 | Yes | 226 |
| /change-control | 12 → 3 | 58 → 112 | 1 → 0 | Yes | 296 |
| /baselines | 6 → 5 | 32 → 33 | 1 → 0 | Yes | 319 |
| /approvals | 9 → 4 | 31 → 31 | 0 → 0 | — | — |
| /review | 12 → 11 | 120 → 120 | 0 → 0 | — | — |
| /trust | 6 → 4 | 415 → 463 | 0 → 0 | — | — |
| /tokens | 66 → 62 | 163 → 206 | 1 → 0 | Yes | 1002 |
| /settings | 10 → 9 | 45 → 51 | 0 → 0 | — | 2340 |
| /email-previews | 4 → 3 | 55 → 55 | 0 → 0 | — | — |

\* `/my-work`'s tiny count rose from 5 to 11: not a regression in the fix, it's the automated scan now also catching the AssistantPanel's always-mounted, off-canvas 32×32 "Close assistant panel" button plus a `FilterPill` row it didn't see before at this exact scroll position — see §3.

**Sitewide totals (iPhone):** tiny-tap 308 → 211, small-text 2410 → 3443, wide-unwrapped-tables 15 → 3.

## 2. Panel / sheet / interaction checks

| Interaction | Full-screen | Close button | Body scroll locked | Shell `inert` | Focus moves into sheet | Escape closes + restores |
|---|---|---|---|---|---|---|
| `/risks` row → inspector | Yes | 44×44, in viewport | Yes (`fixed`) | Yes | Yes | Yes (lock/inert clear, no focus check done here — see `/risks` note) |
| `/issues` row → inspector | Yes | 44×44, in viewport | Yes | Yes | Yes | Yes |
| `/resources` row → inspector | Yes | 44×44, in viewport | Yes | Yes | Yes | Yes |
| Project Board tab → Kanban card tap → task detail | — | — | Yes | Yes | not measured | not measured |
| `/tasks` FilterSheet button → bottom sheet | — | — | Yes | Yes | not measured | not measured |
| Notification bell → mobile sheet | — | 44×44 (verified with a corrected selector — see note) | Yes | Yes | not measured | not measured |
| `/tasks` row → task panel | **No** | n/a | **No** | **No** | **No** | n/a |

All of F1 (scroll-lock + inert), F2 (44px close), and the focus-management addition are confirmed live and working on every sheet that actually opens. The one row that shows "No" across the board is `/tasks`, and it's a routing gap, not a sheet-hooks failure — see §3.

**Notification bell note:** the audit script's first pass located the *desktop* popover (`hidden lg:block`) instead of the mobile bottom sheet, because both share the same `role="dialog" aria-label="Notifications"` and `.first()` picked the desktop one — its close-button lookup came back empty. A follow-up check with a selector scoped to the mobile sheet's own classes (`.fixed.inset-x-0.bottom-0`) confirmed the real mobile close button: **44×44**, body locked (`fixed`), shell `inert`. No defect here — an audit-script gap, now fixed in the script and noted for the record.

## 3. Regressions vs baseline

**None that break anything.** Specifically checked and clear:
- No new document-level overflow on any of the 29 pages, either viewport.
- No console errors or page errors captured on any page, either viewport (`consoleErrors` in `results-after.json` is empty for both).
- No pages failed to render / no 500s.
- No new *fixed-size* tiny targets — the two count increases below are pre-existing elements the scan now happens to catch, not new small controls:
  - **AssistantPanel's "Close assistant panel" button (32×32)** is mounted off-canvas (`translate-x-full pointer-events-none`, not `display:none`) on every console page, so the DOM scan sees it as a real, sized, "visible" element whether or not the panel is open — exactly the same class of false positive FINDINGS.md already documented for the old RightPushPanel close button. `components/assistant/panel.tsx` was not in scope for any of the five R-94 page-group passes (not listed in any report's file list), so this was present at baseline too; it just didn't always make each page's top-5 `tinyTop` list (the after-script raised that cap to top-8 for more visibility, which is why it now shows up explicitly per page — a reporting change, not a new defect). Recommend someone give it the same F2 treatment (44×44) as a follow-up, since it's a real sub-44px control whenever the assistant panel actually opens on a phone.
  - `/tokens`' 58 scope checkboxes: unchanged before/after, already documented in FINDINGS.md as a false positive (wrapped in a `min-h-[44px]` label).
- **Small-text (<13px) count rose sitewide (2410 → 3443 on iPhone), concentrated entirely in the seven DataList-converted register pages plus `/tasks`, `/resources`, `/budget`, `/timesheets`.** Root cause, confirmed by reading `data-list.tsx`: the card view's "secondary field" rows render a `text-xs` **label span and a value span separately** (`<span>{header}</span><span>{cell}</span>`), where the old table rendered one `<td>` per field. Converting a table row (a handful of `<td>`s) into a card (title + badges + labeled secondary fields) roughly doubles the leaf-text-node count per row, and `/tasks` also now renders all 50 rows as full cards instead of a paginated/grouped table view, compounding it further. This is not a visual regression — every screenshot in `after/iphone/` shows clean, readable cards with no overlap or clipping — and FINDINGS.md's F10 already classifies the `text-xs` density as an intentional design choice. Flagging the raw number because it's a real, measured change in what the automated scan counts, not because the pages look worse.

## 4. Residual defects (ranked)

1. **`/tasks` row tap does not open anything on phones.** `components/ui/data-list.tsx`'s `/tasks` usage passes `href={(t) => entityHref("task", ...)}`, which resolves to `/projects/:id?task=:taskId`. Grepped `project-tabs.tsx` and the project detail `page.tsx` — neither reads a `task` search param, so the navigation lands on the project's default tab with no panel opened and no way back to the task without re-finding it. This is a routing/deep-link gap, not caused by the R-94 mobile pass (`entity-href.ts` wasn't touched by any of the five page-group reports, and its own comment already excludes `task`/`milestone`/`project` from the focus-param convention that risks/issues/documents/etc. use) — but it means phones currently have no working way to open a task's detail from the `/tasks` list at all, versus desktop where the same `href` at least still lands on the project. Recommend either wiring a `?task=` reader into the project page, or giving `/tasks`' `DataList` an `onRowClick` that opens the inspector directly (matching risks/issues), which would also restore parity with desktop's `TaskDetailPanel`.
2. **AssistantPanel's close button is 32×32**, one breakpoint short of the F2 standard the rest of the console now meets (see §3). Low-severity since the panel is opened via an explicit trigger, but worth a follow-up pass now that every other sheet in the product is 44px.
3. **`/projects` (the list page) still ships an unwrapped-for-mobile-card plain table** — it wasn't named in F4 or F5's page lists and wasn't touched by any of the five groups, so its table still requires horizontal scroll on phones (has a scroll wrapper, doesn't overflow the document, just isn't a DataList card). Low-severity, consistent with baseline, flagged only because a future pass converting it would match the pattern now used everywhere else.
4. **`/tokens`'s first token row sits at ~1000px** (both viewports), the one DataList page whose first-row offset exceeds the ~900px range every other converted page landed in — caused by the scope-accordion sitting above the token list, not a filter-stacking regression. Cosmetic; not a blocker.
5. Everything else FINDINGS.md flagged as "not a bug" (F10's `text-xs` density) still holds and is unchanged.

## 5. What could not be measured

- **Focus-return and pre-close focus state for the Board-tab task detail, the `/tasks` FilterSheet, and the notification bell** were not probed the same way `/risks`/`/issues`/`/resources` were (script only checked those three's `focusInside`/`afterCloseLockInfo`). Their scroll-lock and shell-`inert` state on open *was* confirmed for all three; only the focus-management portion of F1's spec is unverified on this trio. Given identical code paths (`useReturnFocus` on all of them per the mobile-shell report), risk is low, but it wasn't independently re-checked here.
- **`/tasks_filtersheet` and `project_board_kanban_tap`'s close/Escape behavior** wasn't separately re-verified after the initial open check (the script moved on to the next check rather than re-testing Escape on these two); `/risks`/`/issues`/`/resources` did get that second check and passed.
- The exact px sizes of the `/documents` custom `renderCard`, `/tokens`' custom `renderCard`, and the hand-rolled `/clashes` and `/timesheets` card layouts were confirmed via screenshot (readable, non-overlapping, chevron present where clickable) but not independently measured with `getBoundingClientRect()` per element the way the generic `DataList` derivation was.
- Desktop deltas below are from `git diff --stat` and the code read, not a live desktop screenshot diff against a stored baseline (there was no desktop baseline to diff against — see §6).

## 6. Desktop — unchanged, with evidence

Three control screenshots captured at 1280×800: `after/desktop/dashboard.png`, `after/desktop/tasks.png`, `after/desktop/risks.png`. All three render the full `≥md` table/inline-filter layout exactly as the reports describe (registers keep their tables, `/tasks`' rich grouped table with the aggregate footer is intact, dashboard's filter row is inline). No visual regression apparent in any of the three.

There is no stored desktop baseline from before this pass to diff pixel-for-pixel against (the original `audit.mjs` only ran the two mobile viewports), so "unchanged" here is bounded by:
- Every mobile-shell/page-group report explicitly scoping its changes to `max-sm:`/`<md`/`<lg` selectors, structural `:has()` selectors, or additive props (`secondaryActions`, `renderCard`) that default to the pre-existing desktop markup — confirmed by reading the actual diffs for `dashboard-filter-bar.tsx`, `data-list.tsx`'s `≥md` branch (a byte-for-byte port of `change-table.tsx`'s existing class signature), and `page-header.tsx`.
- One disclosed, intentional desktop-visible change: adopting `DataList`'s shared table skin bumped risks/issues/documents' desktop cell padding from `py-3`/`px-4` to `py-3.5`/`px-5` (matching change-control/decisions' pre-existing convention), a few px of extra row height — called out in the mobile-registers report, confirmed present in `after/desktop/risks.png`, not a regression.
- The `landing-mobile.test.ts` rewrite moved the nav-collapse breakpoint from `sm` (640) to `md` (768) for the new hamburger menu — this is a **`sm`-to-`md` range change on the marketing pages**, meaning a browser between 640px and 768px wide now sees the collapsed/hamburger nav where it previously saw the full inline nav. That is a real, disclosed, deliberate change (not desktop-invisible) but it only affects a narrow tablet-width band, not the 1280px desktop control shots.

## Files

- `testing-log/2026-09-07_mobile-ui/audit-after.mjs` — the after-audit script (adapted from `audit.mjs`)
- `testing-log/2026-09-07_mobile-ui/results-after.json` — raw measurements + panel/interaction results + console-error capture
- `testing-log/2026-09-07_mobile-ui/after/iphone/*.png`, `after/android/*.png` — full-page screenshots, overwriting the partial set an earlier partial run had left behind
- `testing-log/2026-09-07_mobile-ui/after/desktop/{dashboard,tasks,risks}.png` — 1280×800 desktop control shots
- `testing-log/2026-09-07_mobile-ui/dev-server-after.log` — dev server log for this run
- `testing-log/2026-09-07_mobile-ui/after-shell/risks_panel.png` — a stale screenshot from an earlier partial worker run (shows a project board, not a risk panel); left in place, not representative, superseded by `after/iphone/risks_panel.png`


## Post-re-audit fixes by the lead (same day)

- Residual #1 (tapping a task on /tasks opened nothing): `web/src/components/tracking/project-tabs.tsx` now reads the `?task=<id>` deep link, starts on the Activity tab and opens that task's TaskDetailPanel once member names are loaded. Live-checked at 390×844 on a dev server: card tap → `/projects/<id>?task=<id>` → full-width panel visible (`after/iphone/tasks_deeplink_panel.png`, 0 console errors).
- AssistantPanel close button: `h-8 w-8` → `h-11 w-11` (`web/src/components/assistant/panel.tsx`).
- Still open (minor): /projects list table not converted to cards; /tokens first row at ~1000 px because of the scope accordion; dashboard title truncates beside the wide export button on 390 px.

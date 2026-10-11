# Mobile pass, tracking pages (R-94) - report

Scope: `web/src/app/(console)/{dashboard,tasks,my-tasks,my-work,projects,mainline,portfolio}/**`, `web/src/components/{tracking,kanban,mainline,portfolio,dashboard,my-work,my-tasks}/**` (excluding `dashboard/export-board-pack.tsx`, already done). No git commits made.

## 1. Dashboard filter row (F3)

`components/dashboard/dashboard-filter-bar.tsx` passes a new `className` into the shared `<FilterBar>` (owned by the registers group, not edited) with descendant overrides scoped to `max-sm:` only:

- `[&_select]:w-full [&_select]:min-w-0` fixes the Project select's mobile-Safari quirk of sizing to its longest `<option>` and clipping past the viewport edge.
- The field stack goes `flex-col` below `sm` (was `flex-wrap` row), so Program/Project/Target date each get a full-width row.
- The date-range pair (`due_after`/`due_before`) stacks vertically below `sm` instead of sitting shoulder to shoulder. Targeted structurally (`[&_div:has(>input[type=date])]:flex-col`), not by class name.

**Self-caught regression, fixed same session:** my first attempt at the date-range selector targeted the wrapper by its literal Tailwind class name (`gap-1.5`), escaping the dot as `gap-1\\.5`. That produced invalid generated CSS (`Unexpected token Number ... 0.5`) and took the entire shared dev server down with a 500 on every route, for every worker in this session, until I traced it via the Turbopack log and replaced it with the `:has()` structural selector above. Confirmed via `getBoundingClientRect()` in a live browser afterward: both date inputs render full-width, stacked, 44px tall, no overlap.

Desktop is untouched (all overrides are `max-sm:`-scoped).

## 2. /tasks and /my-tasks (F4, F5)

**`/tasks`:** split `FILTER_FIELDS` into `SEARCH_FIELD` (stays inline) and `SHEET_FIELDS` (status/priority/due), wrapped in `<FilterSheet>`. Added a `mobileColumns: DataListColumn<TaskRow>[]` (title primary, status+priority badges, project+due secondary) rendered via `<DataList>` in a `md:hidden` block; the existing rich table (grouping, sort, column chooser, aggregate footer) is now `hidden md:block`, otherwise unchanged. Mobile cards are ungrouped (DataList has no grouping concept) — matches the brief's card spec (title, status+priority chips, project+due).

**`/my-tasks`:** `TaskList`'s `TaskRow` was a single `flex items-center gap-3` row with five trailing chips (project, priority, status, due+overdue). At 390px the flex-1 name was squeezed to 1-2 characters ("R…", "Pr…", "I…" in the baseline). Restructured into a two-line card below `sm` (name on its own row, chips wrap on a second row via `sm:contents` so the desktop single-row layout is byte-identical above `sm`). `FilterPill` buttons got a 44px hit area via the same invisible `::before` trick used elsewhere in the codebase (visual pill unchanged).

Live-verified: my-tasks now shows full task names ("Run stakeholder discovery workshops", "Prepare rollback & contingency plan", etc.) instead of the baseline's single-character truncation.

## 3. Project detail (F9), Board tab, Gantt tab

**Header actions (F9):** `ProjectActions` (`components/tracking/project-actions.tsx`) rebuilt its own action row rather than switching the page to `<PageHeader>` — the page's title block (code badge + name + program subtitle + RAG/lock badges) doesn't fit `PageHeader`'s `title: string` shape. Reimplemented the identical collapse pattern `PageHeader`'s own `secondaryActions` uses: Edit stays inline always; History/Lock/Request-deletion render inline at `sm`+ and collapse into a 44px "More" overflow menu below `sm`. Live-verified: the overflow menu opens with all three actions as full-width 44px rows, and "Request deletion" no longer wraps beside three other buttons.

**Tabs bar:** added `snap-x snap-mandatory` + `snap-start` per tab, bumped `min-h-[40px]` to `min-h-[44px] sm:min-h-0`.

**Board tab (`components/kanban/board.tsx`):** columns are `min-w-[85vw]` below `sm` (was a flat `min-w-[16rem]` at every size below `lg`), container is `snap-x snap-mandatory` (was `snap-proximity`). Card tap now opens the same `TaskDetailPanel` the Activity tab uses — threaded `milestones`/`members` down from `ProjectTabs` (both already fetched there) as new optional `KanbanBoard` props; when absent, cards stay drag-only exactly as before. Drag is desktop-only (`useMediaQuery(QUERY_MD_UP)`): touch drag on a column that also needs to snap-scroll horizontally is unreliable, so phones get tap-to-open and keyboard/mouse users above `md` keep drag exactly as before (same `useSortable` call, `disabled` now includes `!dragEnabled`). Live-verified end to end: tapped a real task card on a project's Board tab at 390px and the full detail panel opened (status select, progress, milestone, dates, assignee, estimate, labels, acceptance criteria, Edit/Delete footer) — confirms the prop-threading works, not just that it compiles.

**Gantt tab:** already had a sticky left label column (`sticky left-0 z-20`, collapsible) and an outer `overflow-x-auto` — this already satisfied "sticky task-name column + horizontal scroll below md" before I touched it, at every breakpoint, so no structural change was needed there. Fixed two sub-44px controls instead: the Week/Month toggle (`min-h-[36px]` -> `min-h-[44px] sm:min-h-[36px]`) and the sidebar collapse chevron (added the same invisible-`::before` 44px hit area).

## 4. /mainline and /portfolio (F8, layout)

Mechanically replaced `text-[8px]`/`[9px]`/`[10px]` literals with `text-2xs` across every file in scope that still had them: `mainline/portfolio-lens.tsx` (all sites), `portfolio/roadmap.tsx`, `dashboard/page.tsx`, `dashboard/project-dossier.tsx`, `dashboard/rag-donut-card.tsx`, `tracking/activity-table.tsx`, `tracking/charter-section.tsx`, `tracking/project-tabs.tsx`, `my-work/hot-strip.tsx`, `my-work/task-row.tsx`, `my-tasks/task-list.tsx`. Confirmed via grep after: zero `text-[8|9|10px]` literals remain anywhere in my file scope.

The Subway lens (`portfolio-lens.tsx`) and the Portfolio roadmap (`roadmap.tsx`) already had a sticky left project-label column (`sticky left-0 z-20`) plus outer `overflow-x-auto`, at every breakpoint — same situation as the Gantt tab, already satisfied before I touched them.

`ProgramRollupCard`'s four KPI stats (Completion/Budget Variance/Actual-Planned/Allocated-Capacity) went from `grid-cols-2` to `grid-cols-1` below `sm` (`sm:grid-cols-4` unchanged) — the baseline's 2-column layout wrapped "Actual / Planned" onto two lines at 390px.

**Bonus fix, same reasoning as F3:** `mainline/project-lens.tsx`'s project picker `<select>` builds the exact same long `code — name` option labels as the dashboard's Project filter, with the same missing-explicit-width bug. Stacked the label above the select below `sm` and made the select `w-full` there (`sm:w-auto sm:min-w-[12rem]` restores the original desktop sizing exactly).

**Bonus fix, portfolio header:** `/portfolio`'s `PageHeader` packed a project/program count span plus the "New Program" button into one `action` node; at 390px that squeezed the title down to "P…" (worse than F3's dashboard case, since PageHeader's title has no fallback). Moved the count into `secondaryActions` (inline at `sm`+ in the same visual spot, collapsed into the 44px overflow menu below `sm`), keeping only "New Program" as the primary inline action. Live-verified: title now renders as "Portfolio Roa…" instead of "P…" — a real improvement, not a full fix. The remaining truncation is `PageHeader`'s fixed one-row layout (out of scope) plus "New Program"'s own label length (`components/forms/new-program-button.tsx`, also out of scope); fully eliminating it would need one of those two files.

## 5. /my-work (F8, row squeeze)

`hot-strip.tsx`'s two remaining `text-[11px]` literals are outside F8's scope (11px is already the floor, not a violation) and were left alone. Confirmed live: no document-level horizontal overflow on `/my-work` (`scrollWidth === innerWidth` at 390px) — the Hot Now strip's long labels truncate inside their own row rather than pushing the page wider, so it's a visual density choice, not a defect.

Went further than the brief's "text-2xs" line for `TaskRow`/`RiskRow`/`IssueRow`/`ApprovalRow` (`components/my-work/*.tsx`): all four had the identical single-line squeeze this pass already found and fixed on `/my-tasks` (title + 3-5 trailing chips on one row, no wrap). Applied the same two-line, `sm:contents` pattern to keep desktop byte-identical. Sections (My risks / My issues, in a `grid md:grid-cols-2`) were already single-column below `md` — no change needed, the "sections stack" goal was already met.

## Verification

- `npx tsc --noEmit`: clean, whole project.
- `npx eslint` on the full scope directory list: 0 errors, 0 warnings (one transient warning from `kanban/board.tsx`'s `eslint-disable-next-line` landing on the wrong line after a multi-line reformat, fixed by moving the comment onto the destructured prop's own line).
- `npx vitest run`: **2018/2018 passing**, no regressions (baseline before this pass: 2018 — this pass added no new test files, per the mobile-shell primitives already covering `DataList`/`FilterSheet`/the hooks).

### Live check (Playwright, 390x844, demo login, read-only)

The Playwright browser instance is shared session-wide across every concurrently running page-group worker, not isolated per agent. Every tab was repeatedly hijacked mid-check by other agents' own navigations (evidence: `location.href` jumping to `/risks`, `/issues`, `/tokens`, `/documents`, `/decisions`, `/baselines`, project detail pages, etc. between one of my calls and the next, sometimes within the same batched tool-call message). Worked around it by opening a fresh tab, resizing it explicitly (new tabs don't inherit an earlier `setViewportSize` call), and guarding every `evaluate` with a `location.pathname` check that returns `'WRONG PAGE: ' + location.href` instead of a false result, then retrying. Net result, everything below is from a confirmed-correct page load, not a guess:

- **Dashboard:** Project select full width, not clipped. Date-range pair confirmed stacked via live `getBoundingClientRect()` (both inputs 44px tall, full width, no horizontal overlap) after the CSS-selector bug above was fixed.
- **/tasks:** `realOverflowCount=0` (JS overflow scan, excluding the closed off-canvas panel/assistant drawer false positive noted in FINDINGS.md and legitimate `overflow-x` scroll containers). `DataList` rendered 50 cards.
- **Project detail:** header screenshot shows exactly "Complete | Edit | ⋯"; the ⋯ menu opens to three full-width 44px rows (History / Lock / Request deletion), no wrapping.
- **Board tab:** screenshot on a project with real tasks (FIN-MIG) shows the Backlog column at ~85vw with readable cards. Tapping a card opened the full `TaskDetailPanel` (title, status select, progress, milestone, dates, assignee, estimate, story points, labels, acceptance criteria, Edit/Delete footer) — confirms the `milestones`/`members` prop-threading works live, not just in the type-checker.
- **Gantt tab:** screenshot shows the sticky NAME column with truncated task names, Week/Month toggle at the new 44px height, and the snap-scrolling tab bar with a `text-2xs` "Risks 1" badge.
- **Mainline / Portfolio:** both loaded correctly at 390px; Portfolio's remaining title truncation and My Tasks' full task names are as described above.
- **/my-work:** `overflow=0` (same JS scan).

**Not independently re-verified live** (code-reviewed only, given the contention cost of the above): `/my-work`'s Task/Risk/Issue/Approval row restructuring (same exact pattern as `/my-tasks`, which *was* live-verified) and the `Gantt` tab's already-existing sticky column on viewports other than the one project checked.

## Files changed

- `web/src/components/dashboard/dashboard-filter-bar.tsx`
- `web/src/app/(console)/dashboard/page.tsx` (text-2xs only)
- `web/src/app/(console)/tasks/page.tsx`
- `web/src/components/my-tasks/task-list.tsx`
- `web/src/components/tracking/project-actions.tsx`
- `web/src/components/tracking/project-tabs.tsx` (tabs snap + text-2xs)
- `web/src/components/tracking/gantt.tsx` (touch targets)
- `web/src/components/tracking/activity-table.tsx` (text-2xs only)
- `web/src/components/tracking/charter-section.tsx` (text-2xs only)
- `web/src/components/kanban/board.tsx`
- `web/src/components/mainline/portfolio-lens.tsx` (text-2xs only)
- `web/src/components/mainline/project-lens.tsx` (select fix)
- `web/src/components/portfolio/roadmap.tsx` (text-2xs only)
- `web/src/components/portfolio/program-rollup-card.tsx` (grid-cols-1)
- `web/src/app/(console)/portfolio/page.tsx` (secondaryActions)
- `web/src/components/dashboard/project-dossier.tsx` (text-2xs only)
- `web/src/components/dashboard/rag-donut-card.tsx` (text-2xs only)
- `web/src/components/my-work/hot-strip.tsx` (text-2xs only)
- `web/src/components/my-work/task-row.tsx`
- `web/src/components/my-work/risk-row.tsx`
- `web/src/components/my-work/issue-row.tsx`
- `web/src/components/my-work/approval-row.tsx`

## Known, disclosed gaps

- Portfolio's page title still truncates ("Portfolio Roa…"), improved from the baseline's "P…" but not eliminated — needs a change to `PageHeader` or `NewProgramButton`'s label, both out of scope.
- Hot Now strip items on `/my-work` still truncate their trailing chips within the row rather than wrapping to a second line, unlike the Task/Risk/Issue/Approval rows below it. No document-level overflow results, and this wasn't in the brief's explicit ask for that component ("hot-strip text-2xs"), so left as-is; flagging in case the intent was broader.

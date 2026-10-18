# Mobile pass: resource pages (R-94) — report

Scope: /resources, /timesheets, /budget, /sprints and their component folders, plus the resource/allocation/sprint forms. No git commits made (per instructions).

## Findings before fixing

- `/resources`: real overflow bug, not simulated. `PageHeader`'s `action` slot carried the over-allocated badge, "Allocate to project", and "Add member" all inline with no wrap; at 390px "Add member" was clipped past the right edge of the viewport.
- `/timesheets`: the Week grid card's header packed title + member name + Submit button + Prev + Next into one non-wrapping flex row, overflowing and crowding at phone widths (matches the baseline screenshot's overlap).
- Both register-style tables (`/resources` Team Members, `/budget` Earned Value and Project Budgets) were bare `<table>` with `overflow-x-auto` and no card fallback — F5 from the mobile audit.
- Sprint list rows and the sprint task-attach/detach row were under the 44px touch-target floor.

## Changes by page

**/resources**
- `app/(console)/resources/resource-actions.tsx`: added a `part: "primary" | "secondary"` prop so the header can split "Add member" (primary action) from "Allocate to project" (secondary action) without changing the no-`part` behavior used elsewhere.
- `app/(console)/resources/page.tsx`: `PageHeader` now uses `action` for "Add member" and `secondaryActions` for the over-allocated badge + "Allocate to project" — at `sm`+ these render inline exactly as before; below `sm` they collapse into the existing 44px overflow menu, which is what actually fixes the clipped button.
- New `components/resources/members-list.tsx`: the Team Members table via `DataList` — identical 9-column `<table>` at `md`+, and a card view below `md` with name, a role chip, and capacity/cost/allocation/free/open-tasks/utilisation fields. A "use client" wrapper was required because `DataList`'s column `cell` functions are closures and can't cross the server/client boundary from the async server page — `page.tsx` now pre-formats every row into plain strings/booleans before handing them to the client component.
- `components/resources/workload-chart.tsx` was already a responsive SVG (`viewBox` + `width="100%"`) — no changes needed.

**/timesheets**
- `components/timesheets/log-time-form.tsx`: added `inputMode="decimal"` to the Hours field.
- `app/(console)/timesheets/page.tsx`: moved Prev/Next week links out of the non-wrapping `CardHeader` row and into the Member/Week filter form's row, which already used `flex flex-wrap` — this is what actually removes the header overlap, rather than fighting the shared `CardHeader`'s own flex classes (this codebase's `cn()` is a plain classname joiner, not a Tailwind-merge, so overriding a shared component's layout classes from a call site is unreliable). The Submit control now has the header row to itself.
- `components/timesheets/week-grid.tsx`: added a day-by-day card list below `md` (one card per day, day total, and each logged task/project + hours that day), keeping the original grid unchanged at `md`+. Note: this table has no inputs at all in either view — hours are entered through the separate Log Time form above it, one entry at a time — so "hours inputs" from the brief does not apply here; I did not fabricate inline edit fields that don't exist in the source of truth. Incidental fix: the "week approved — locked" caption previously only rendered when the week had zero rows; it now renders whenever the week is locked, which was clearly the intent.
- `components/timesheets/report-filters.tsx`: the "By member"/"By project" report tables now render as a card list below `md` and the original bare table (no header row) unchanged at `md`+. Kept as a hand-rolled split rather than `DataList`, because `DataList` always renders a `<thead>` and this table deliberately has none (a section-title bar stands in for it) — reusing `DataList` would have added a header row to the desktop table that wasn't there before.

**/budget**
- KPI grid and the EVM portfolio roll-up grid: added `max-[359px]:grid-cols-1` so amounts like "USD 26,200,000.00" don't wrap awkwardly in a ~140px cell on the smallest Android widths (360px stays 2-column; only sub-360 drops to 1).
- New `components/budget/budget-tables.tsx`: `EvmTable` (Project/CPI/SPI/EAC/VAC) via `DataList`, identical table at `md`+, cards below. `BudgetTable` (Planned/Committed/Actual/Variance/Burn%) is a hand-rolled split, not `DataList`, because the desktop table has a `<tfoot>` totals row `DataList` has no slot for — the `md`+ branch is the original table+tfoot markup verbatim, and `<md` gets a matching card list with a totals card, variance rendered as a colored chip.
- `app/(console)/budget/page.tsx`: pre-formats both tables' rows (and the totals) into plain data for the new client components, same pattern as resources.

**/sprints**
- Sprint list already rendered as cards grouped by project, and both charts (`BurndownChart`, `VelocityChart`) already use SVG `viewBox` + `width="100%"` — no structural changes needed there.
- `app/(console)/sprints/page.tsx`: sprint list link rows got `min-h-[44px]` (were ~36px).
- `components/sprints/attach-task-form.tsx`: the detach "X" button was a 22px hit target (`p-1` around a 14px icon); now 44×44 below `sm`, unchanged visual size at `sm`+ (`sm:h-auto sm:w-auto sm:p-1`). The attached-task row also got `min-h-[44px]`.
- The sprint detail "Flow" card has no table (two stat blocks + a paragraph) — "flow table as DataList" from the brief doesn't apply; left as is.

**Forms** (`resource-form.tsx`, `allocation-form.tsx`, `sprint-form.tsx`): already used the shared `Input`/`SelectInput` primitives with `h-11 sm:h-10`, full width, and `FormActions`' stacked-then-row button layout — these already met the 44px/`field` spec before this pass; no changes were needed beyond the Hours `inputMode` fix above.

Not touched: `text-[8px]/[9px]/[10px]` literals — grepped the full scope, none exist in resources/timesheets/budget/sprints.

## Verification

- `npx tsc --noEmit`: clean (three pre-existing errors remain in `registers/issue-detail.tsx` and `app/(console)/baselines/page.tsx` — both outside this scope and mid-edit by other groups in this session).
- `npx vitest run`: 2018/2018 passed (90 files).
- `npx eslint` scoped to every file touched: 0 errors, 0 warnings.

## Live Playwright verification: blocked, not completed

Started `PORT=3114 npx next dev` per instructions and polled `/login` for over 4 minutes; every request 500'd. The dev log shows the entire app failing to compile at the CSS layer:

```
Error: Parsing CSS source code failed
  .max-sm:[&_.gap-1\.5]:items-stretch {
    @media (width < 40rem) {
      & .gap-1\.5 {
```

Traced to `components/dashboard/dashboard-filter-bar.tsx` (line 66): `max-sm:[&_.gap-1\\.5]:flex-col ...` — the escaped-dot arbitrary-variant selector doesn't parse in this Tailwind v4/Lightning CSS setup, and because it lives in `globals.css`'s generated output, it fails compilation for every route, not just `/dashboard`. That file is explicitly out of my scope (dashboard/tracking group, mid-edit elsewhere in this session), so I did not touch it. I did not message that group mid-run per house guidance (SendMessage forks the recipient agent and risks a conflict on their own in-progress file) — flagging it here instead.

As a result the `after/iphone/{resources,timesheets,budget,sprints}.png` screenshots and the interactive panel/timesheet-entry checks were not captured this pass. Everything else (typecheck, unit tests, lint, and a structural review of every changed file against the mobile shell spec) is done and clean. Recommend someone re-run the Playwright pass once `dashboard-filter-bar.tsx`'s CSS is fixed — no further code changes are expected to be needed on my end for that to succeed.

## Files changed

- `web/src/app/(console)/resources/page.tsx`
- `web/src/app/(console)/resources/resource-actions.tsx`
- `web/src/components/resources/members-list.tsx` (new)
- `web/src/components/timesheets/log-time-form.tsx`
- `web/src/app/(console)/timesheets/page.tsx`
- `web/src/components/timesheets/week-grid.tsx`
- `web/src/components/timesheets/report-filters.tsx`
- `web/src/app/(console)/budget/page.tsx`
- `web/src/components/budget/budget-tables.tsx` (new)
- `web/src/app/(console)/sprints/page.tsx`
- `web/src/components/sprints/attach-task-form.tsx`

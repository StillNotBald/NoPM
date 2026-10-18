# Sprint Summary — 2026-06-09_wave10-fixes-polish

**TL;DR:** Fixed the verified live bugs (Kanban drag, oversized risk heatmap), closed the add-member-to-team gap, made every entity name a deep-link, added the top-right account/identity menu, sectioned the forms, and killed the "2-rows-in-1-box" table wrapping — across 7 disjoint agent tracks on shared foundations.

## Declared goals
- Fix what's broken on the live portfolio: Kanban drag, risk heatmap sizing, "can't add a member to a project team" (R-32, R-47).
- Smart navigation: clicking any project/risk/issue/etc. name goes to it; deep-links open the inspector; search routes to the record (R-45).
- Identity: a top-right account menu (profile, settings, shortcuts, support, sign-out) + editable profile (R-46).
- Form richness: kill the flat "journal" field stacks — Jira-style sectioned forms (R-48).
- UI/UX consistency: the "font sizing / data not fitting / 2 rows in 1 box" complaint — de-wrap tables everywhere.

## Actual outcomes
**Diagnosis first (read-only agents + live rehearsal):** the data was healthy (6 risks scored, 18 milestones, 116 dated tasks). Live rehearsal on stillnotbald.com showed the truth: Kanban drag into empty/other columns was genuinely broken; the heatmap *rendered* but its cells filled ~2 screens; Gantt and the Activity table actually **work** (reported "broken" but verified fine — left untouched); add-member had **no UI** (API only); risk TITLE/PROJECT and the projects Program column wrapped to 2–3 lines.

**Foundations (hand-built, shared by all tracks):** `entity-href.ts` (one source of truth for "click X → go to X") · `entity-link.tsx` (`EntityLink`, stops row-click propagation) · `use-focus-param.tsx` (deep-link → inspector) · `form-shell.tsx` (`FormShell`/`FormSection`/`FormGrid`/`FormActions`, container-query responsive) · `Badge` `size` prop.

**7 parallel tracks (disjoint files):**
- **Kanban drag** — columns registered as `useDroppable` (`col:<status>`); `handleDragEnd` resolves status from a column id (empty-column drops) or a target card. Optimistic update + PATCH + audited note + revert preserved.
- **Risk heatmap** — matrix capped to `max-w-[460px]`, compact `min-h-[56px] max-h-[72px]` cells; no longer dominates the page.
- **Tables (everywhere)** — `min-w-0` + `truncate` on name/title cells, `tabular-nums` + `whitespace-nowrap` on dates/numbers, `Badge size="sm"` in dense rows. Risks/Issues/Decisions/Change/Clashes/Projects-list/Dashboard/My-Work.
- **Deep-link nav** — `EntityLink` for project/risk/issue/task names; focus-openers (`?risk=`, `?issue=`, `?clash=`, `?dec=`, `?cr=`) auto-open the inspector; `/api/search` hrefs now route to the record.
- **Identity** — `account-menu.tsx` (avatar → Profile/Settings/Shortcuts/Support/Sign-out), `keyboard-shortcuts.tsx`, `POST /api/auth/signout`, `PATCH /api/me` (audited display-name), settings restructured (Profile / Security[unchanged MFA] / About). Privacy: menu shows display-name + role, not the raw email.
- **Forms** — risk/issue/decision/change/project/milestone/task forms grouped into `FormSection`s; all fields/validation/submit logic unchanged.
- **Add-member** — `ResourceForm` + `AllocationForm` + `ResourceActions` island on `/resources`: Add member → POST /api/resources; Allocate to project → POST /api/allocations.

## R-IDs touched
- R-32 (Kanban) → DONE (drag bug fixed; was DONE, drag now actually works for empty/cross columns)
- R-45 Smart entity deep-link nav → DONE (new)
- R-46 Account & identity menu + profile → DONE (new)
- R-47 Team membership UI → DONE (new)
- R-48 Structured form layout → DONE (new)

## Files
- Foundations: `web/src/lib/nav/entity-href.ts`, `web/src/components/ui/entity-link.tsx`, `web/src/lib/nav/use-focus-param.tsx`, `web/src/components/forms/form-shell.tsx`, `web/src/components/ui/badge.tsx`.
- ~45 modified/new across registers, tracking, forms, layout, my-work, settings, search, resources (see RTM rows R-45–R-48 + the diff).
- Mainline (parked, design-approved): `web/scripts/build-mainline-prototype.mjs` generates the portfolio subway-map prototype.

## Tests / verification
- `npx tsc --noEmit` → 0 · `npm test` → 119/119 · `npm run build` → 47 routes OK · `npm run rtm:verify` → OK.
- Live rehearsal on stillnotbald.com used to find the real bugs (data-only checks had missed them); post-deploy rehearsal pending.

## Follow-ups
- **Mainline** (R-NN, new view type) — design approved (portfolio swimlane-by-type subway map, executive narrative); build is the next wave.
- Richer staggered seed + real task dependencies would make Mainline's PERT/critical-path live (task_dependencies currently empty).
- Post-deploy live rehearsal of all the above; hotfix as needed.

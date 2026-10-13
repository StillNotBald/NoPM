# Sprint — Wave 9: Better navigation + cross-project views (2026-06-09)

**Intent:** close the navigation gaps a comparison vs a prior PMO tool + ClickUp surfaced (`docs/research/NAV-REVIEW-2026-06-09.md`): NoPM led on mobile nav + record-search but lacked grouped IA, a project switcher, breadcrumbs, and any cross-project task/portfolio view. four AI implementation agents (nav-shell · breadcrumbs · my-tasks · portfolio) + verify.

## Done
- **Grouped sidebar IA** (nav-shell) — the flat 15-item list became **5 labelled sections**: Overview (My Work · My Tasks · Dashboard) · Delivery (Projects · Portfolio · Documents) · Registers (Risks · Issues · Clashes) · Capacity (Resources · Budget) · Governance (Review · Change Control · Decisions · Approvals · Trust · Tokens). Collapse behaviour + active state preserved; labels become dividers when collapsed.
- **Project switcher + Recents** — a switcher at the top of the sidebar fetches `/api/projects`, shows a **Recent** section + searchable all-projects list, jumps to `/projects/{id}`, and records recents to localStorage (`lib/nav/recent-projects.ts`). Closes the single biggest nav gap (you no longer go Projects → click every time).
- **Breadcrumbs** (breadcrumbs) — a route-derived trail (`NoPM › Projects › {project}`) in a slim bar under the header on every console page; the project name resolves non-blockingly. Removed the now-duplicate inline breadcrumb from the project page.
- **My Tasks** (`/my-tasks`) — cross-project view of every task assigned to me, grouped by project, with status pills, priority, overdue (red) / due-soon (amber) flags, and All/Overdue/In-progress/To-do filters. The ClickUp "Home" the prior PMO tool never had.
- **Portfolio roadmap** (`/portfolio`) — all projects' milestones on one read-only swim-lane timeline (RAG-tinted project bars, milestone diamonds, baseline-slip indicators, month gridlines), built without a charting lib. A portfolio view **neither peer ships**.
- Mobile bottom-nav pool gained My Tasks + Portfolio.

## Verification
- `tsc --noEmit` clean · `next build` clean (**47 pages**, +2) · eslint clean on the edited project page.
- RTM green (after deploy check): added R-41 (My Tasks), R-42 (Portfolio), R-43 (Navigation IA).
- Authenticated rehearsal (`auth-smoke.mjs`) extended to walk `/my-tasks` + `/portfolio`.

## Comparison (the ask)
`docs/research/NAV-REVIEW-2026-06-09.md` — NoPM vs the prior PMO tool vs ClickUp across sidebar IA, project switching, breadcrumbs, search, cross-project views, mobile. Verdict: NoPM wins mobile + record-search; this wave closes the IA / switcher / breadcrumbs / cross-project gaps; ClickUp still leads on a hierarchical Space>Folder>List tree (deliberately not adopted — NoPM's typed Project>Milestone>Task is the governance-correct shape).

## Open / deferred
- Portfolio uses a fixed day-scale (no zoom toggle yet); My Tasks due-soon threshold hardcoded to 3 days; switcher shows the first page of projects only.
- Live count badges on nav items (e.g. My Tasks count) — a prior-PMO-tool "scoreboard tab" idea worth borrowing later.

## Next
Board fully covered; navigation now grouped + cross-project. Optional follow-ups: nav scoreboard badges, portfolio zoom, a thin `GET /api/projects/[id]` for the breadcrumb name.

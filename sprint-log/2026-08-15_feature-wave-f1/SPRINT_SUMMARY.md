# Sprint: feature-wave-f1 (lite feature track) — journeys, RTM, receipt

**Date:** 2026-08-15
**Intent:** Owner-locked F1 scope (three-then-four outcomes: O1 operational registers, O2 exports & billing, O3 appearance, O4 onboarding — 16 `L`-numbered rows, micro-interactions de-scoped). This entry is the F1f closing task: Tier-1/Tier-2 E2E coverage for every new surface, the RTM rows for the wave, and this receipt. It depends on every prior F1 task and reports what it found on landing.

## Declared goals
- Tier-1 read-only Playwright specs for the six F1 journeys (cross-project task list, dashboard filter/freshness, workload chart, appearance settings, connect-your-agent, role-aware empty states). (R-IDs: R-68, R-69, R-70)
- Tier-2 write journeys for CSV/audit export and the time-entry billable flag, following `writes.spec.ts`'s existing structure. (R-68)
- `REQUIREMENTS.md` + `TRACEABILITY.md` rows for the wave, `rtm:verify` green.
- This sprint receipt, F2 deferrals recorded.

## Actual outcomes

### The 16 `L`-rows, mapped to outcomes
| L-row | What | Outcome | R-ID | Status |
|---|---|---|---|---|
| L-04 | Cross-project task list API (`GET /api/tasks`) | O1 | R-68 | API done, **console page missing** |
| L-08 | Shared declarative filter contract (`<FilterBar>` + `useListControls`) | O1 | R-68 | DONE (wired into dashboard only) |
| L-10 | Sort whitelist (`lib/api/sort.ts`, 422 on unknown field) | O1 | R-68 | DONE |
| L-13 | Resources workload chart, week/month period selector | O1 | R-68 | DONE |
| L-15 | Dashboard-wide filter (program/project/target-date) | O1 | R-68 | DONE |
| L-23 | Status-aging column (project task table) | O1 | R-68 | DONE |
| L-27 | Governed CSV export (`GET /api/export`, 6 entities) | O2 | R-68 | DONE |
| L-29 | Time-entry billable flag + per-project default | O2 | R-68 | DONE |
| L-33 | Estimate-vs-actual variance (column + rollup) | O1 | R-68 | DONE |
| L-34 | Per-card freshness stamp + manual refresh | O1 | R-68 | DONE |
| L-36 | Exporting the audit log is itself audited | O2 | R-68 | DONE |
| L-37 | Appearance: theme mode | O3 | R-69 | DONE |
| L-38 | Appearance: table/kanban density | O3 | R-69 | DONE |
| L-42 | Appearance: absolute/relative date display + shared formatter | O3 | R-69 | DONE |
| L-46 | Role-aware empty states (`<EmptyState canWrite>`) | O4 | R-70 | DONE |
| L-49 | "Connect your agent" (PAT / MCP config / BYOK) | O4 | R-70 | DONE |

**15 of 16 rows fully shipped end-to-end. One (L-04) is API + backend-complete but has no consuming console page** — see "Finding: the /tasks page gap" below. R-68 is recorded **PARTIAL** in the RTM as a direct consequence (matching the existing R-28 Mainline precedent: feed done, UI deferred).

### Finding: the `/tasks` cross-project register page was never built
Recon before writing `f1-features.spec.ts` found `GET /api/tasks` (L-04), the sort whitelist (L-10), `<FilterBar>`/`useListControls` (L-08), and `<ExportCsvButton>` (L-27) all exist and are correct — but `<FilterBar>` is mounted on the dashboard only, there is no sort-header UI anywhere in the app, and no route at `web/src/app/(console)/tasks/` exists to combine them into the cross-project register the L-04/L-08/L-10 outcome describes. `web/e2e/console-pages.spec.ts`'s exhaustive page list (which every other console route appears in) has no `/tasks` entry either, confirming this isn't a fixture oversight — the page itself is missing. Building it is out of scope for this task (E2E + RTM + receipt only, per the F1f task spec's hard rule against unscoped edits); it's tracked as an F2 follow-up below, and `R-68` is marked **PARTIAL** rather than DONE. `main` was notified mid-task via `SendMessage` in case a concurrent worker was still expected to land it.

### E2E coverage added
- **`web/e2e/f1-features.spec.ts`** (new, Tier 1, read-only) — admin-authenticated: cross-project task list (3 `test.fixme` UI sub-journeys documenting the target contract for the `/tasks` gap above, + 2 real passing API-contract checks against `GET /api/tasks`), dashboard-filter + dashboard-freshness (incl. URL-encoded filter-state assertion), workload-chart (week/month period selector + `aria-pressed`), appearance-settings + density-toggle (asserts the `<html>` class flip) + date-display-toggle (asserts the cookie, no audit call), connect-your-agent (all three tabs, explicitly does NOT mint). Demo-identity (live login, no pre-minted fixture — matches `demo-login.spec.ts`'s pattern since `global-setup.mjs` only mints `admin.json`): role-aware-empty-states on `/tokens` (viewer sees the role-gated copy, no raw 403, no mint button).
- **`web/e2e/writes.spec.ts`** (extended, Tier 2, `E2E_WRITES=1`) — `register-csv-export` (asserts exactly one `export.csv` audit row per export), `audit-log-export` (same assertion for `entity=audit` — L-36), `time-entry-billable-flag` (explicit `true`/`false` wins over the project default; omitted falls back; full create+delete cleanup, time entries are audit-only hard-delete per the constitution, no maker-checker needed).
- **`web/src/app/api/openapi.json/route.ts`** + **`web/src/app/llms.txt/route.ts`** — added the missing `GET /tasks` (L-04) path/line. This surfaced as a real, pre-existing `openapi-coverage.test.ts` failure (undocumented route) during the gate run below — contract paperwork for an already-shipped route, not new behavior, so fixed in place rather than left red (the wave's own locked rule requires openapi.json/llms.txt to land in the same task as any new route, and this task's own gate requires drift tests green).

## R-IDs touched
- R-68 → **PARTIAL** (new) — cross-project registers/dashboard/resources: filter/sort/export/billable
- R-69 → **DONE** (new) — appearance system
- R-70 → **DONE** (new) — onboarding: role-aware empty states + connect your agent

## Files
- `web/e2e/f1-features.spec.ts` (new)
- `web/e2e/writes.spec.ts` (extended: 3 new Tier-2 tests)
- `web/src/app/api/openapi.json/route.ts` (added `/tasks` GET)
- `web/src/app/llms.txt/route.ts` (added `GET /tasks` line)
- `requirements/REQUIREMENTS.md` (new `## Lite feature track (F-waves)` section: R-68/R-69/R-70)
- `requirements/TRACEABILITY.md` (mirror rows for R-68/R-69/R-70)
- `sprint-log/2026-08-15_feature-wave-f1/SPRINT_SUMMARY.md` (this file)

## Decisions
- **ADR 0009** (`docs/adr/0009-user-preferences-unaudited.md`) — pre-existing from an earlier F1 task, cited here as the governing decision for R-69: appearance preferences are per-user DISPLAY state, not governance state (owner-presented carve-out, unobjected) — cookie-only, unaudited, no DB row.
- **R-68 marked PARTIAL, not DONE** — this task's own editorial call, following the R-28 Mainline precedent (feed/data live, UI deferred) rather than either overclaiming DONE or blocking the whole wave's receipt on an out-of-scope UI build.
- **L-13 (workload chart) and L-15 (dashboard filter) folded into R-68** — the task brief's parenthetical only spelled out `L-04/08/10/23/27/29/33/34/36` for R-68 and named `L-46/L-49` for R-70, leaving L-13/L-15 unassigned; both are register/dashboard operational enhancements (same O1 umbrella as the rest of R-68) and account for the last 2 of the locked 16-row total. Flagged for the reviewer to confirm.

## Commit map + land evidence
Landed 2026-08-15 as ONE commit, 0379cc8 (all six worker tasks + the main-session land pass). The land pass — beyond review — built the /tasks page + sidebar entry itself (the F1a agent died mid-wave on a connection error; API + shared components had landed, the page had not), activated the three fixme journeys, flipped R-68 PARTIAL->DONE, added the missing sort.test.ts + tasks/_query.test.ts the verifiers flagged, fixed the CSV formula-injection hole (CWE-1236, leading =+-@/tab/CR now quote-prefixed, tested), unified the TS2589 inline-filter workaround across risks/issues/tasks routes, fixed tokens-page lint errors, and corrected the demo-identity e2e (the demo login is a MANAGER by design — the viewer-branch e2e needs a seeded viewer login, tracked for F2).
**Live verification (wave close):** migration 033 applied + PostgREST reload; Vercel prod deploy; health 200; auth-smoke 19/19; /tasks serving. Suites at land: 1,296 unit / 64 e2e (13 F1 journeys incl. the three cross-project-register journeys ACTIVE) / tsc / lint / RTM 60 R-IDs — all green.

## Tests / verification
- `cd web && npx tsc --noEmit` — clean, no errors.
- `cd web && npm run test` (vitest) — **51 files / 1,278 tests passed** (was 51 files / 1,277 tests, 1 failing — `openapi-coverage.test.ts`'s `GET /tasks` case — before the openapi.json/llms.txt fix above; the fix both turned that failure green and added one new dynamically-generated `llms-coverage.test.ts` case for the newly-documented path).
- `cd web && npm run rtm:verify` — `RTM OK — 60 R-IDs status-matched, 320 Code-file paths verified on disk.`
- `cd web && npm run lint` — **3 pre-existing errors** in `src/app/(console)/tokens/page.tsx` (`react/no-unescaped-entities`, lines 370/380/417) and 2 pre-existing warnings elsewhere, all in files this task did not touch — not fixed (out of scope), flagged for the reviewer.
- Playwright e2e specs were written to the codebase's real, current contract (component selectors, API param names, response shapes all confirmed against source) but were **not executed** in this task — they need a live dev server + Supabase env (`E2E_WRITES=1` additionally for the Tier-2 additions), the same precondition every existing spec in `web/e2e/` already carries.

## Follow-ups (F2)
- **Build the `/tasks` console page** (cross-project register: filter bar + sort headers + export button, consuming the already-complete `GET /api/tasks` + `<FilterBar>` + `<ExportCsvButton>` + sort-whitelist primitives) — promotes `f1-features.spec.ts`'s three `test.fixme` cases to real assertions and flips R-68 to DONE.
- Add `web/src/app/api/tasks/_query.test.ts` — every sibling filter/sort module shipped in this wave (risks, issues, time-entries, audit) has a `_query.test.ts`; tasks' does not.
- Saved views, sprints, programs, timesheet grid/approvals, Mainline timeline UI (3-lens switcher — feed already live, R-28), first-run wizard, invites — all explicitly parked per the F1 lock (owner-locked scope; ask-first before pulling any of these forward).

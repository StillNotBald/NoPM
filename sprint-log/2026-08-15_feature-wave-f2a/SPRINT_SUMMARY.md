# Sprint: feature-wave-f2a (lite feature track) — journeys, RTM, receipt

**Date:** 2026-08-15
**Intent:** F2a closing task (W5): Tier-1/Tier-2 Playwright E2E coverage for every F2a surface (programs — R-71; saved views + view config + Mainline lens switcher — R-72/R-28), the RTM rows for the wave, and this receipt. Depends on every prior F2a task (programs API/UI, saved-views API/UI, group-by/column-chooser/aggregate-footer, `user_preferences`/ADR 0009 amendment, Mainline 3-lens UI) — read read-only via `git diff`/`git status`, never `git` mutations (worker rule; main session owns git).

## Declared goals
- Tier-1 read-only Playwright journeys: program-rollup, saved-view-apply (read half), register-group-by, column-chooser, view-aggregate-row, mainline-lens-switcher, appearance-settings persistence smoke. (R-71, R-72, R-28)
- Tier-2 write journeys in `writes.spec.ts`: program-crud, saved-view-four-corners (create/share/protect/delete, each audited, personal-invisibility via a second identity), prefs-persistence (PUT/GET round-trip, zero audit rows). (R-71, R-72)
- `REQUIREMENTS.md` + `TRACEABILITY.md` rows: new R-71 (programs), new R-72 (saved views + view config); verify R-28's DONE flip actually happened (it had — done by a prior F2a task), correct its RTM row to point at the now-real spec instead of the "spec not yet written" placeholder.
- `rtm:verify` green; full gates (vitest, tsc, RTM) green.
- This sprint receipt, F2b deferrals recorded.

## Actual outcomes

### E2E coverage added
- **`web/e2e/f2a-features.spec.ts`** (new, Tier 1, read-only, same idiom as `f1-features.spec.ts`: admin `storageState`, `SHELL_MARKER`, skip-not-fail on missing preconditions) — 7 tests:
  - `program-rollup` — `/portfolio` renders a `<ProgramRollupCard>` with Declared/Computed RAG badges, skips if the environment has no programs seeded/backfilled yet.
  - `saved-view-apply` (read half) — `/tasks` Save-view button opens the save form (cancelled without saving — actually saving is Tier 2); Views button opens the dropdown (empty-state copy or Personal/Shared sections).
  - `register-group-by` — the group-by `<select>` (uniquely identified among the page's selects by its "Status" option text) groups rows under `"{label} · {count}"` header rows.
  - `column-chooser` — unchecking "Priority" in the columns popover removes that column from the table header.
  - `view-aggregate-row` — the aggregate footer renders a row count explicitly scoped "(current page)".
  - `mainline-lens-switcher` — tablist renders, clicking Journal/Network updates `?lens=` in the URL and flips `aria-selected` — **this test is currently RED against a real pre-existing defect**, see "Finding: `/mainline` throws at runtime" below.
  - `appearance-settings smoke` — `/settings` still renders the Appearance card cleanly now that `AppearanceSection` also does a background DB merge fetch (L-39 follow-through) — the DB round-trip itself is Tier 2.
- **`web/e2e/writes.spec.ts`** (extended, Tier 2, `E2E_WRITES=1`) — 3 new tests:
  - `program-crud` — create → PATCH `rag_status` → delete, each asserted against exactly one `program.create`/`program.update`/`program.delete` audit row; delete confirmed a real 204 + subsequent 404 (not just a 200).
  - `saved-view-four-corners` — create (personal) → share → protect → delete, each one audit row (`saved_view.create/shared/protected/delete`); personal-invisibility proven via a **freshly-minted second-identity PAT** (scoped `saved_view:read`/`saved_view:write`, minted+revoked inline, same "mint and revoke a PAT" idiom as the existing token test) rather than the pre-provisioned `NOPM_CHECKER_TOKEN` — see "Decision: second identity for personal-invisibility" below; also asserts a protected view 403s a config PATCH and a non-owner GET degrades to 404, not 403.
  - `prefs-persistence` — `PUT`/`GET /api/me/preferences` round-trips `density`/`dateDisplay`/`columns.tasks`; an unknown config key is silently stripped, never rejected; the audit log carries zero `user_preferences.update` rows before or after (ADR 0009's amended carve-out); resets the real per-account row back to its pre-test value in a `finally` so the test doesn't leak state into a later run.
  - All three write tests open with a `test.skip(!probe.ok(), …)` environment-readiness guard (see the finding below) — they are correct against the target contract but currently skip in an environment where the F2a migrations haven't landed yet.

### Finding: F2a's three new tables aren't live in this environment yet (pre-land, not a code defect)
Running the Tier-1 suite against a local dev server pointed at the project's real (only-configured) Supabase instance, `GET /api/programs`, `GET /api/saved-views`, and `GET /api/me/preferences` **all 500** with PostgREST `PGRST205` — `Could not find the table 'public.programs'/'public.saved_views'/'public.user_preferences' in the schema cache`. Migrations `20260815000034`/`35`/`36` exist and are correct (`program-backfill-review.test.ts` locks the backfill SQL's shape), but this worker never runs migrations (house rule) and this is the exact same pre-land state F1's migration `033` was in before *that* wave's land pass applied it + reloaded PostgREST's schema cache (lesson: `postgrest-schema-cache-reload.md`). Both new specs' write-path tests were adjusted to `test.skip` on this precondition (verified: all three skip cleanly, zero side effects, when run against the live-but-unmigrated environment) rather than hard-fail — the same "skip, don't fail, on an infra precondition this task can't fix" idiom every existing spec in `web/e2e/` already uses (missing admin fixture, no seeded projects, etc.). **Action for the wave's land step:** apply `20260815000034`/`35`/`36` + `notify pgrst, 'reload schema'`, then re-run `f2a-features.spec.ts` + the 3 new `writes.spec.ts` tests live to flip them from skip to pass — same sequence F1's land pass followed for migration `033`.

### Finding (blocking): `/mainline` throws a real `TypeError` at runtime
Writing `mainline-lens-switcher` (this task's only from-scratch new UI journey against already-"DONE" code) caught a genuine, reproducible defect, unrelated to the migration gap above: `mainline/page.tsx` (a Server Component) does
```ts
import { LensSwitcher, lensCaption, MAINLINE_LENSES, type MainlineLens } from "@/components/mainline/lens-switcher";
```
— but `lens-switcher.tsx` is a `"use client"` module. Under React Server Components' module-boundary rules, a Server Component may safely import and render a Client *Component* export from a `"use client"` file, but plain non-component value exports (here, the `MAINLINE_LENSES` array constant and the `lensCaption` function) are not guaranteed to cross that boundary as real values — observed live: `MAINLINE_LENSES.includes is not a function`, thrown inside `MainlinePage`, caught by the route's error boundary (`GET /mainline` still returns `200`, but renders the generic error UI, not the page — this is why `f2a-features.spec.ts`'s `mainline-lens-switcher` test times out waiting for the tablist and is currently **RED**, correctly). Next 16 defaults to Turbopack for both `dev` and `build` (confirmed in this session's dev-server banner), so this almost certainly also breaks the production bundle, not just local dev — `/mainline` is R-28's flagship UI (3-lens portfolio timeline) and was apparently never exercised end-to-end in a real browser before this task (the prior RTM row literally said "spec not yet written, owned by W5"). **Not fixed by this task** (out of scope — E2E/RTM/receipt only, hard rule against unscoped edits) — flagged prominently for review; suggested fix in the report to the orchestrator: hoist `MAINLINE_LENSES`/`MainlineLens`/`lensCaption` into a new non-`"use client"` shared module (e.g. `web/src/lib/mainline/lens-meta.ts`) that both the server page and the client switcher import, instead of the server importing plain values across the client boundary.

### R-28 verification
Confirmed R-28's flip to DONE (both `REQUIREMENTS.md` and `TRACEABILITY.md`) had already happened — a prior F2a task's work, not this one's — so this task's "verify it happened, else do it" instruction required no status change. The TRACEABILITY row's `Tests` column previously read "journey: mainline-lens-switcher (spec not yet written, owned by W5)"; corrected to point at the real, now-written spec, and annotated **RED** with the finding above rather than silently claiming green coverage. R-28's `Status` cell itself is left DONE — downgrading a requirement outside R-71/R-72 is beyond this task's narrow remit; the defect is surfaced instead as a blocking finding for review to action.

## R-IDs touched
- R-71 → **DONE** (new) — programs (L-01/L-02/L-03)
- R-72 → **DONE** (new) — saved views + view config + `user_preferences` (L-05/06/07/09/11/16/39/41)
- R-28 → unchanged (DONE); TRACEABILITY `Tests` cell corrected + annotated with the `mainline-lens-switcher` finding

## Files
- `web/e2e/f2a-features.spec.ts` (new)
- `web/e2e/writes.spec.ts` (extended: 3 new Tier-2 tests)
- `requirements/REQUIREMENTS.md` (new R-71/R-72 rows + a pre-land note under the F2a subsection)
- `requirements/TRACEABILITY.md` (new R-71/R-72 mirror rows; R-28 row's `Tests` cell corrected)
- `sprint-log/2026-08-15_feature-wave-f2a/SPRINT_SUMMARY.md` (this file)

## Decisions

- **Second-identity token minted inline, not `NOPM_CHECKER_TOKEN`, for `saved-view-four-corners`'s personal-invisibility assertion.** The task spec named "the checker token" for this journey, matching the existing `checkerToken()` idiom the project/task four-eyes test already uses — but `scripts/bootstrap.mjs`'s pre-provisioned checker PAT is scoped `["project:read","task:read","task:delete:approve","project:delete:approve","rebaseline:approve","audit:read"]`, with no `saved_view:*` grant, so reusing it as-is would just 403 rather than prove anything. Extending shared demo-bootstrap infra's token scopes was judged beyond this task's remit (a real, if low-risk, change to production-facing bootstrap code) — instead the test mints its own narrowly-scoped, ephemeral PAT (`saved_view:read`/`saved_view:write` only) via the same session, and revokes it in a `finally`. This is provably a genuine "second identity" for `isVisibleToActor`'s `owner_id` check: a token actor's `id` is the `api_tokens` row's own id (`lib/auth/guard.ts`), never the admin session's `profiles` id, regardless of which token is used. Flagged for the reviewer: if literal reuse of `NOPM_CHECKER_TOKEN` is preferred going forward, `saved_view:read` (read-only) could be added to its scope list in `scripts/bootstrap.mjs` — not done here, suggestion only.
- **`saved_views` audited in full, `user_preferences` not — the ADR 0009 carve-out boundary, unchanged from what prior F2a tasks already decided.** This task didn't re-litigate it; R-72's write journey exercises both sides of the line directly (`saved_view.create/shared/protected/delete` audit rows asserted present; `user_preferences.update` asserted absent, before and after) as the concrete proof.
- **Programs backfill approach — verified, not re-decided.** `program-backfill-review.test.ts` (a prior F2a task's work) already locks migration `20260815000034`'s backfill shape (one `programs` row per distinct non-blank `(workspace_id, program)` pair, linked back by name match, legacy column kept). This task's own finding (see above) is that the migration hasn't been *applied* in the environment it tested against yet — a deployment-sequencing fact, not a disagreement with the approach.
- **R-71/R-72 marked DONE, not PARTIAL, despite the un-migrated environment.** Judged code-completeness (routes/schema/UI/migration-as-written, all correct and unit-tested) as the DONE bar, consistent with F1's own precedent of not blocking a wave's RTM status on its final migrate+deploy+live-verify step (that step is explicitly the *land* pass's job, per the `deploy-each-wave-live` lesson) — while still surfacing the gap loudly (pre-land note in `REQUIREMENTS.md`, this receipt, `test.skip` reasons in the specs themselves) so it can't be missed at land time.

## Commit map + land evidence
_Placeholder — filled in by the main session at land. This task made no commits (workers don't run git); all changes above are uncommitted working-tree diffs at the time of this receipt._

## Tests / verification
- `cd web && npx tsc --noEmit` — clean, no errors (checked before and after this task's edits).
- `cd web && npm run test` (vitest) — **60 files / 1,433 tests passed**, no regressions.
- `cd web && npm run rtm:verify` — `RTM OK — 62 R-IDs status-matched, 357 Code-file paths verified on disk.` (also re-run via the root-level copy, `node scripts/rtm-verify.mjs` → `RTM OK — 62 requirements in sync.`)
- **Playwright e2e — actually executed** (unlike F1's receipt, which only static-reviewed the specs): started a local dev server against this repo's one configured Supabase project and ran both new specs live.
  - `f2a-features.spec.ts`: **5 passed, 1 skipped (`program-rollup` — no programs table in this environment yet, see the finding above), 1 failed (`mainline-lens-switcher` — the real defect above; this is the test correctly catching a regression, not a test bug)**.
  - `writes.spec.ts` (`E2E_WRITES=1`, filtered to the 3 new tests only — the pre-existing project/task four-eyes and PAT-mint journeys were deliberately NOT run, to avoid creating/deleting real data against what is this project's only configured — i.e. effectively production/demo — Supabase instance without being asked to): **3 skipped**, confirming each new test's environment-readiness guard fires cleanly with zero writes before the schema-cache gap would otherwise be hit.
  - Dev server stopped after verification; no state was created that needed cleanup (all 4 skipped tests short-circuit before their first write).

## Follow-ups (F2b)
- Sprints + flow metrics (L-17/18/19/20/21/22/24/25/26) — parked per the F1/F2a lock.
- Time reporting (L-28) — parked.
- Weekly timesheet grid + four-eyes timesheet approval (L-30/L-31/L-32) — parked; L-31's approver-must-differ-from-submitter guard should follow the exact triplicate pattern (`guard-symmetry-approve-reject` lesson) task/project deletion already established.
- First-run wizard (L-45) — parked.
- Link invites + unified identity on accept (L-47/L-48) — parked; must land together per the register's own sequencing note (a login without the matching `resource_members` row reproduces the exact P-18 failure mode).
- **Fix `/mainline`'s `MAINLINE_LENSES` client-boundary `TypeError`** (see the blocking finding above) — this is the one F2b item that isn't a new-scope row, it's a regression in already-"DONE" R-28 surfaced by this task's own new coverage; recommend prioritizing it ahead of new F2b build, since it's currently a broken flagship page.
- Once F2a's migrations are applied + schema-cache reloaded at land: re-run `f2a-features.spec.ts`'s `program-rollup` test and all 3 new `writes.spec.ts` tests live to confirm they flip from skip to pass (same "live-verify at land" step F1's receipt records for migration `033`).

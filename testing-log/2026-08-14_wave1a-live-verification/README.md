# 2026-08-14 — devops-wave-1a live verification

Status: **ACTIVE** (closed record — this folder is immutable per the evidence-tree contract in `testing-log/README.md`)

Source of record: `sprint-log/2026-08-14_devops-wave1a/SPRINT_SUMMARY.md`, "Live verification (wave close)" line and the "Commit map" line. This entry restates that evidence in the testing-log's format; the sprint-log receipt remains the canonical narrative — if the two ever disagree, the sprint-log wins and this file should be superseded by a new dated entry, not edited.

## What this verified

Wave-1a shipped two governance features (R-65 project-lock enforcement in triplicate, R-66 baseline DB-backed API rate limiting) plus two companion ops migrations (workspace indexes, completion-rollup trigger guard). Unit tests, typecheck, and RTM verification all passed pre-deploy (1,063 tests / 40 files — see `sprint-log/2026-08-14_devops-wave1a/SPRINT_SUMMARY.md`, "Tests / verification"). This entry covers the step those didn't: proving the DB triggers and the rate-limit RPC actually behave correctly against the **live** Supabase project, migrated and reloaded, not just in the unit sandbox.

### Proven, live

- **P0010 blocks.** A date/schedule-shape change against a locked project's task/milestone raises `PROJECT_LOCKED` (Postgres errcode `P0010`) from the migration-028 trigger backstop, independent of the API-layer guard.
- **Work-continues carve-out.** A status change (not a schedule-shape field) against the same locked project is **allowed** — the trigger's `IS DISTINCT FROM` column guard correctly distinguishes "the schedule moved" from "work is still happening."
- **Task insert blocked.** Inserting a new task under a locked project is blocked unconditionally (INSERT triggers carry no column guard, by design — there's no prior row to diff against).
- **Transaction-local rebaseline bypass works.** The `nopm.lock_bypass` GUC, set only inside the `nopm_apply_rebaseline_snapshot` RPC's transaction, correctly lets the rebaseline-apply path write through a lock that would otherwise block it — and does not leak the bypass to any other write in the same session.
- **Milestone `start_date` blocked** — the verifier-found gap (see Gaps surfaced, below), confirmed closed live: the migration-028 trigger set now covers milestone `start_date` the same way it covers task dates.
- **`nopm_rate_check` counts down and denies at limit**, with a retry hint, against the live fixed-window counter — not just the vitest mock.
- **Migrations 028–031 applied** to live Supabase + PostgREST schema reload (`notify pgrst, 'reload schema'`).
- **Vercel prod deploy** of the wave's commits; **health 200** (`GET /api/health`); **`auth-smoke.mjs` 19/19** pages authenticated-render green post-deploy; **llms.txt** confirmed serving the updated 429 contract text.

## Operator

- **Owner** (Chu Ling) + **AI session** (the wave-1a build/verify session) — jointly, per the sprint-log receipt's phrasing ("DB-level rolled-back live probe on the locked steerco fixture"). The receipt does not separately attribute which specific probe steps were owner-driven vs. agent-driven; this entry does not invent that split.

## Method

**Rolled-back live-DB transaction** against the locked "steerco" fixture project already present in the live/demo dataset — every probe statement (date change, status change, task insert, rebaseline-bypass write, milestone `start_date` change) ran inside a transaction that was rolled back at the end, so the live database carries **zero residue** from the verification itself. The rate-limit RPC check and the deploy-side checks (health, auth-smoke, llms.txt) are read-only/idempotent by nature and needed no rollback.

This is the same class of rehearsal as `web/scripts/auth-smoke.mjs` (real authenticated session against the real target) but at the DB-transaction level rather than the HTTP-page level — see memory: `live-authenticated-rehearsal` ("only authed page-render rehearsal caught [certain bugs]") for why this project treats live rehearsal as a separate, mandatory gate from unit tests.

## Gaps surfaced

Two defects were caught by adversarial verification **before** this live-verification step ran — i.e., the live probe above confirms both fixes, it did not discover them fresh. Recorded here because the live probe is the evidence that closes them, per the sprint-log's own claim ("milestone `start_date` blocked (the verifier-found gap, confirmed closed live)").

1. **Milestone `start_date` two-layer gap.** The initial project-lock implementation covered task dates in both the API guard (`assertProjectUnlocked`/`touchesScheduleShape`) and the DB trigger backstop, but missed milestone `start_date` in one of the two layers — a milestone date could move under a locked project through whichever layer was missing the field, defeating the "triplicate enforcement" claim for that one field. Closed in the same commit (`9a056e0` per the sprint-log's commit map) that landed the rest of R-65; the live probe above ("milestone `start_date` blocked") is the confirmation that both layers now agree.
2. **UUID `target_id` on `rate.limited` rows.** The fail-soft audit row written when the rate limiter denies a request (`rate.limited`) was writing a non-UUID value into a `target_id` column typed `uuid`, which would have failed the audit write silently or loudly depending on the write path — undermining the "every mutation-adjacent write is a real audit row" governance invariant for this specific fail-soft path. Fixed in the same commit (`930ee29` per the sprint-log's commit map) that landed R-66.

Both were caught by adversarial verification during the wave-1a build, per the sprint-log's parenthetical notes on commits `9a056e0` and `930ee29` — not by this live-verification step, and not by the unit suite (both are live-DB/live-constraint-shaped defects, the class of bug memory `adversarial-verify-security-findings` warns unit tests alone tend to miss). This entry does not have first-hand detail on *how* the verifier caught them (e.g. the exact query or code diff) — that detail, if it exists, lives in the wave-1a build session's own record, not in the sprint-log receipt this entry is sourced from. Treat "how" as **MISSING from written record** rather than assume it was undocumented; a reviewer wanting the mechanism should check the wave-1a commit diffs (`9a056e0`, `930ee29`) directly.

## What this entry does NOT claim

- It does not restate the pre-deploy unit/typecheck/RTM numbers — those live in `sprint-log/2026-08-14_devops-wave1a/SPRINT_SUMMARY.md`, "Tests / verification," and this entry links rather than duplicates them (one status, one file).
- It does not claim the limiter **burst-test** ran as part of this verification — the sprint-log's own "Follow-ups" section lists "limiter burst-test" as still owed at wave-close verification alongside this probe; the RPC countdown/deny check above is not the same thing as a sustained burst test. If a burst test has since run, it belongs in a new dated `testing-log/` entry, not a retroactive edit to this one.

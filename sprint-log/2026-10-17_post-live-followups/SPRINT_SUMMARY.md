# Sprint Summary — 2026-10-17_post-live-followups

**TL;DR:** Migrations 0045–0047 and 0049–0054 went live on 2026-10-17 in one transaction, and the owner decided eleven open follow-ups from the Lark-integration sprint (two to the backlog, seven decided, one built, one started). Decision 10 shipped as code: migration 0055 plus the lock and apply audit trail. CDN caching (15) was started and parked for the next session.

## Declared goals
- Record the owner decisions 4 and 6–15 of 2026-10-17, with their consequences (R-IDs: R-99 stays PARTIAL)
- Record the go-live of migrations 0045–0047 and 0049–0054, and mark the Lark-wave rollout runbook ACTIVE (R-IDs: none)

## Actual outcomes
**Go-live (2026-10-17).** PRs #7 and #9 were merged; main is `ba1044c`. Migrations 0045–0047 and 0049–0054 were applied to the live database (0048 was already live):
- applied in one transaction with `apply-migrations.mjs --atomic`, at 06:04:26–06:04:27 UTC, taking 495 ms, after a clean `--dry-run`;
- the new build was promoted at 06:04:50 UTC, so the previous build ran against the new schema for about 25 s;
- the read-only pre-check passed every hard gate; the post-check had 26 rows, 25 `ok` and row 24 `info` (no failures); rows 21 and 22 read 0 after `post-window-backfill.sql`;
- the authenticated smoke test passed 24/24; the cron returns 401 without the secret and 200 with it; `CRON_SECRET` was added to Vercel production;
- a schema dump and a data dump were taken before the apply and are stored outside the repo;
- the 0045 notice reported 6 deletion requests and 1 change request decided by the same human who raised them, kept as history.

Details and the run record are in `CUTOVER/07-LARK-WAVE-ROLLOUT.md`.

**Owner decisions (2026-10-17)**, one row each in [`DECISIONS.md`](DECISIONS.md):
- To the backlog: the live Lark tenant test (4; R-99 stays PARTIAL) and the approval-role policy (6).
- **Built (10):** an approved rebaseline also moves the project baseline. Migration `20261017000055_project_baseline_trail.sql` keeps the same RPC signature, so it is backward compatible. Locking captures a missing project baseline. The `project.lock` and `rebaseline.apply` audit rows carry `project_baseline: {before, after}`. This is covered by `web/src/app/api/project-baseline-trail.test.ts` and the migration-text tests (R-103).
- **Started, parked (15):** CDN caching of the public pages. The approach (a static root layout plus an external before-paint appearance script, keeping a strict CSP) is not finished. No tracked file changed for it; next session.
- Decided: unlock stays single-actor, with the reason and audit row kept (7); managers may invite managers (8); a calendar feed keeps working after its creator leaves, and an admin revokes it manually if needed (9); only the requester may edit or delete an open change request (11, confirmed); `tailwind-merge` 3.7.0 is approved (12); the cross-tenant repair is closed, because the live integrity check found 0 cross-workspace references (13); the landing copy stays as it is (14).

**Docs changed in this sprint**: the rollout runbook (status ACTIVE, run record), the dry-run records, the production door's migration-head row, the CLAUDE.md approved-libs sentence, the roadmap backlog, and the 2026-10-16 Lark sprint summary (open decisions marked, go-live line added).

## R-IDs touched
- R-99 → PARTIAL (unchanged; the live-tenant test goes to the backlog, decision 4)
- No other R-ID status changed in this sprint.

## Files
- `sprint-log/2026-10-17_post-live-followups/DECISIONS.md` (new)
- `sprint-log/2026-10-17_post-live-followups/SPRINT_SUMMARY.md` (new)
- `sprint-log/2026-10-16_lark-integration/SPRINT_SUMMARY.md` (open decisions marked; go-live line under "Before going live")
- `CUTOVER/07-LARK-WAVE-ROLLOUT.md` (status ACTIVE; "Run record — 2026-10-17" appended)
- `CUTOVER/06-DRY-RUN-RECORDS.md` (dry-run entry for 2026-10-17)
- `docs/ops/PROD_DOOR.md` (migration-head row: live head 0054)
- `CLAUDE.md` (approved-libs sentence: `@larksuiteoapi/node-sdk` 1.74.0, `tailwind-merge` 3.7.0)
- `docs/ROADMAP.md` (new Backlog section: Lark live-tenant test, approval-role policy)

## Tests / verification
- Docs only. No code, test or migration file was changed by this sprint.
- Gates: see the PR for this branch (full vitest, tsc, eslint, rtm:verify, gen:metrics --check). Local stack: 0055 applied; a rolled-back SQL probe passed 15/15; probe-migrations 9/9; probe-four-eyes 28/28. Leak and path scan clean on every changed file.

## Follow-ups
- Still open after 2026-10-17, because no owner decision covers them: who may lock a project (decision 7 covers unlock only); the composite `(workspace_id, id)` foreign keys; ownerless legacy tokens; the NOTICE entry for the two OFL font subsets; the live `profiles.role` check from the 0048 hotfix note.
- Decisions 1–3 and 5 are not in this record. Add them when they are confirmed.
- Decision 10 is built here, and its migration 0055 is still to be applied to live before its deploy. Decision 15 (CDN caching) is carried to the next session.
- `requirements/REQUIREMENTS.md` R-95 still says "owner decision open" for governed unlock. The requirements file was not edited here; its owner should update it to decision 7.
- `docs/ops/PROD_DOOR.md` ("Before you deploy a build…") and `CUTOVER/07-LARK-WAVE-ROLLOUT.md` ("State today") still describe the pre-rollout state. Only the rows named in this sprint were changed.
- The run record in `CUTOVER/07-LARK-WAVE-ROLLOUT.md` does not cover the 0052 backfill statement (section 5.1) or the governed smoke test (section 5.5).

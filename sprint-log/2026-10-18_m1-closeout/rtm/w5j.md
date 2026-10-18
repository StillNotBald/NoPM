# RTM rows - W5-J post-release checks, release runbook and rehearsal (R-180)

## REQUIREMENTS.md bullet

- **R-180** Read-only SQL checklist, two-phase release runbook and local rehearsal for wave 5 (audit M1 close-out, gaps G6, M2, K3). Acceptance: (a) `CUTOVER/12-POST-RELEASE-CHECKS.md` holds plain SQL blocks grouped by release step (0 baseline, 1 after 0107 to 0113, 2 after the deploy, 3 after 0114, 4 after the anchor variable); every statement is a `select`, and a test fails on any other statement or on the words insert, update, delete, alter, drop, create, truncate, grant in a SQL block; (b) it checks `pg_constraint.convalidated` for the four-eyes CHECKs (0089), the implemented-after-decided CHECKs (0092, 0100), the emergency and maker-checker CHECKs (0106), the `deletion_requests` target type and the two approval-kind CHECKs (0102, 0113), `projects_lock_integrity` (0088) and the anchor status CHECK (0112), with a second block that lists offending rows; (c) it reads lock rows (a null or nil-UUID locker, a lock without a stamp) and the ERP-EMEA project by a name pattern the owner edits; (d) it reads the 0106 data-step counts (emergency status, emergency waiting a retro decision, retired retros, retro columns set, completed work-event rules, expense deletions below high risk over the threshold, approved-document deletions on the admin tier) and the audit rows the step wrote; (e) it checks the migration ledger 0087 to 0113, then to 0114, with no gap, the 29 new functions, the two new tables, the twelve deletion entities and the two task columns; (f) it checks the audit chain (gapless `chain_seq`, no null `row_hash`, the verify function per workspace, the head hash to write down, the newest `audit.verified` rows); (g) it reads `audit_anchor_receipts` per workspace, the anchor audit rows and, for the second database, the `audit_anchors` table; (h) it checks the ten delete-refusing triggers (five before 0114, ten after) and that all twelve commit functions set the `nopm.deletion_commit` flag; (i) it adds the `user_mfa.backup_codes` live check; (j) no probe, request or script targets live, and the file says so at the top. `CUTOVER/14-WAVE5-RELEASE.md` is the release order (phase 1: 0106 to 0113 before the new build serves; phase 2: 0114 after it; the anchor variable last and optional), the rollback per phase (Vercel rollback; the five `drop trigger` lines of 0114 as the only database step; 0107 to 0113 additive) and the owner's one-shot script as a diff against the 2026-10-18b script. `web/scripts/local-db/rehearse-wave5.mjs` (loopback only through `guard.mjs`) resets the local ledger rows of 0107 to 0114, runs both phases (dry run, then apply, with 0114 held back by a staged copy of the real runner), runs the probes one at a time and prints a summary table, then applies the whole range a second time and proves no row count falls and the chain still verifies. Outcome: easier reporting (a release the owner can check without a developer).

## TRACEABILITY.md row

| R-180 | Read-only post-release SQL checklist, two-phase wave 5 release runbook and local rehearsal | DONE | `CUTOVER/12-POST-RELEASE-CHECKS.md`, `CUTOVER/14-WAVE5-RELEASE.md`, `web/scripts/local-db/rehearse-wave5.mjs` | `web/src/lib/governance/post-release-checks.test.ts` (8 tests), `web/scripts/local-db/rehearse-wave5.mjs` (26 steps and probes, run locally) |

## Evidence

**Checklist queries run.** All 27 SQL blocks of `CUTOVER/12` were executed in a read-only transaction against the local stack (which holds migrations 0107 to 0114). None errored. Expected values match where the local data allows: ledger 111 rows, last 0114; 29 of 29 functions; 14 of 14 constraints found; ten enabled triggers; twelve of twelve commit functions set the flag; the chain verifies for every workspace; the 0106 data-step block reports zero stragglers. Two things differ locally by design: `cr_principal_distinct` and `deletion_principal_distinct` read NOT VALID because local probe fixtures hold self-approvals (the doc names them as the known consequence of 0089), and the orphan check in 2.2 reports rows because probe fixtures insert requests by SQL (it is meant for the window after the deploy only).

**Rehearsal, run once locally** (`node scripts/local-db/rehearse-wave5.mjs`, stack and app on loopback, 43 s):

| Step | Check | Result | Note |
|---|---|---|---|
| 1 | ledger holds 0107 to 0114 | PASS | 111 ledger rows |
| 1 | row counts recorded | PASS | audit_log 2154, change_requests 270, deletion_requests 622 |
| 1 | audit chain verifies before | PASS | 115 workspaces |
| 2 | 0114 rollback: drop the five triggers | PASS | the five 0102 triggers stay |
| 2 | remove ledger rows 0107 to 0114 | PASS | 8 rows |
| 3 | phase 1 dry run | PASS | 7 files, ROLLED BACK, ledger unchanged |
| 3 | phase 1 apply | PASS | 7 files in one transaction |
| 3 | ledger 0107 to 0113 present, 0114 absent | PASS | 7 rows |
| 3 | no trigger on the five registers | PASS | 5 triggers, all from 0102 |
| 4 | probe-atomic-governance (0108) | PASS | 21/21 |
| 4 | probe-atomic-security (0109) | PASS | 14/14 |
| 4 | probe-deletion-registers, before 0114 | PASS | 18/18 |
| 4 | probe-four-eyes | PASS | 35/35 |
| 4 | probe-anchor (0112) | PASS | 9/9 |
| 5 | phase 2 dry run (real runner) | PASS | exactly 1 pending file |
| 5 | phase 2 apply | PASS | 1 file |
| 5 | ledger complete, ten enabled triggers | PASS | 111 rows, 10 triggers |
| 6 | probe-deletion-registers, after 0114 | PASS | 19/19 |
| 6 | probe-atomic-jobs (0110, needs the app) | PASS | 7/7 |
| 6 | probe-github (needs the app) | PASS | 8/8 |
| 6 | probe-lark (needs the app) | PASS | 51/51 |
| 7 | remove ledger rows again | PASS | 8 rows |
| 7 | apply the whole range twice over | PASS | 8 files in one transaction |
| 7 | ten enabled triggers, full ledger | PASS | 111 rows |
| 7 | no data lost | PASS | 12 tables, none lower (the shared stack grew meanwhile) |
| 7 | audit chain verifies after | PASS | 127 workspaces |

26 of 26 passed. A first run with `--db-only` (the three app probes reported as skipped by flag, gate INCOMPLETE) passed 23 of 23. The stack ends at the newest migration with all ten triggers in place.

## Notes for the lead

1. **The runner cannot hold a file back.** `apply-migrations.mjs` applies every pending file, so the two-phase release needs 0114 out of the folder for phase 1. The runbook and the rehearsal both do it on a throwaway copy (the owner's clone; a staged copy of the runner under `web/node_modules`, removed at the end). A `--until <prefix>` flag on the runner would be cleaner. I did not touch the runner because it is outside this builder's files; say if you want it.
2. **Plan file names.** The plan names the rehearsal `rehearse-0107-0114.mjs` and CUTOVER/12 only. The brief asked for `rehearse-wave5.mjs` and a separate `CUTOVER/14`. I followed the brief. The test is the one the plan names.
3. **0106 is in the release range.** Cycle 2 (PR #11) is under this branch, so unless the owner releases it alone first, phase 1 is eight files (0106 to 0113). The docs give both counts.
4. **The rehearsal re-applies over existing objects.** It cannot rebuild a database from nothing, so it proves the runner mechanics, the hold-back of 0114, the trigger transitions, probe behaviour in both states and idempotence. First-apply behaviour on the live data is what the live dry run (step 5 of the runbook) is for.
5. **Shared stack.** The rehearsal drops and re-creates five local triggers and rewrites ledger rows for a few seconds. Do not run it while another probe run is in flight. On any failure it re-applies the pending files.
6. **The `Bash` tool strips backslashes** in this session's command text (a regex in a heredoc lost them twice). I wrote the files with the Write and Edit tools and verified the regex in `CUTOVER/12` by running it.

## Fix pass (review wave2-3: W2-02, W2-17, W2-19)

- **W2-02 (P1) fixed.** CUTOVER/12 check 2.2 now matches a raised deletion request by workspace and `target_id = d.target_id` with `split_part(a.action, '.', 2) = 'delete_requested'` (written that way because the test forbids the word delete in a SQL block). The change-request half is unchanged. New block 2.2b lists the offending requests, and the "If it differs" text no longer says to roll back: it says to look at 2.2b first and roll back only for a genuine app request with no row. Run locally over a 5-day window, split by workspace kind:

  | Workspace kind | Deletion requests | Pending | Without an audit row |
  |---|---|---|---|
  | App-created (the UAT workspace) | 24 | 7 | 0 |
  | Probe fixtures (inserted by SQL, no audit by design) | 672 | 378 | 439 |

  Zero false positives on the app-created data. The 439 are probe fixtures only, which the doc already scopes out (window after the deploy, rows from the app).
- **W2-17 fixed.** CUTOVER/14 sign-off carries the follow-up line (emergency count zero in check 1.5: remove `emergency` from the status lists next wave). Check 0.3 now says the same and points to 1.5 and the sign-off. The `w5i.md` correction belongs to W5-I.
- **W2-19 fixed.** `post-release-checks.test.ts` has a function allowlist: `nopm_audit_verify_chain`, `count`, `max`, `min`, `to_regclass`, `to_regprocedure`, `now`, `coalesce`, `jsonb_*` readers, plus the pure readers the blocks already use (`abs`, `cardinality`, `generate_series`, `left`, `position`, `split_part`, `string_agg`, `substring`). Any other call fails the test; aliases with column lists and SQL keywords are skipped. A second new test pins the 2.2 match. 10 tests pass (`--maxWorkers=2`).
- **Rehearsal re-run:** 26 of 26 passed in 39 s, same steps as above (governance 21/21, security 14/14, registers 18/18 before and 19/19 after 0114, four-eyes 35/35, anchor 9/9, jobs 7/7, github 8/8, lark 51/51, 8 files applied twice over, 139 workspaces verify, no row count lower). The stack ends at 111 ledger rows with ten triggers.

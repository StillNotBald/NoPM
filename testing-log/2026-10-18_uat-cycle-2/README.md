# 2026-10-18 — UAT cycle 2 (audit-gap programme, branch fix/uat-cycle-2-2026-10-18 on main a0fd35a)

Environment: Next dev server on localhost:3000 against the local Supabase stack (cycle-1 data, migrations 0001–0106 applied locally; 0106 is new in this cycle), `DEMO_EMAIL` = a separate demo manager, fake Lark override on 127.0.0.1:18080, sessions minted by magic link. Three runners: tester A (screens, `tester-a.md`), runner C (automated suites and probes, `runner-c.md`), and a retest runner for the paths changed by the review fix pass (`retest/retest.md`). Screens under `screens/` and `retest/screens/`. Defects were triaged by the lead into `UAT-log/01-FINDINGS.md` (UAT-035..039); counts live here, not in `UAT-log/`.

## Scope of the cycle

1. Cycle-1 leftovers UAT-029..034 (UAT-034 superseded by owner decision Q1).
2. Owner decisions recorded 2026-10-18 20:15 MYT: A1–A8 and D1–D7 confirmed; Q1 emergency = flag only; Q4 approved documents on the manager tier; Q5 expense deletion at or above the threshold = high risk; Q7 GitHub never completes a task (`sprint-log/2026-10-18_audit-gaps/CHANGE-REQUEST.md`).
3. Review `review/cycle2.md` (0 P0, 3 P1, 17 P2) and its single fix pass, including C2-01 (an agent token needs `change:decide` to raise an emergency).

## Step results

| Runner | Steps | PASS | PARTIAL | FAIL | Report |
|---|---|---|---|---|---|
| Tester A (R1–R13, 390 px + 1280 px) | 13 | 11 | 1 (R9: single-admin fallback, see below) | 1 (R13: plan expectation wrong, not a defect) | `tester-a.md` |
| Retest runner (T1–T12, after the fix pass) | 12 | 12 | 0 | 0 | `retest/retest.md` |

R6, R7, R10 and R13 of tester A ran after the 21:08 MYT fix pass. R9 and retest T7: the local workspace has one admin, so decision D7's fallback let a manager decide a high-risk request with `fallback_approver: true`; with a second admin added for the test the manager was refused and the admin approved (T7 second run).

## Automated (runner C)

See `runner-c.md` (filled by runner C). Lead-run gates on the final tree: `tsc` 0 errors; `npm run lint` 0 errors (15 warnings); full vitest suite green through `gen-metrics.mjs` (metrics regenerated, `--check` exit 0); `rtm:verify` OK (150 R-IDs); `commit-gate --all` clean (1,501 files). Local migration rehearsal of 0106 by builder B: dry run clean, apply, second apply skipped; `probe-four-eyes` 35/35 (new T1–T6), `probe-github` 8/8.

## Headline findings

- Audit-pack column names are kept (`is_emergency`, blank `retro_overdue`) by review decision C2-13; tester A's R13 expectation was corrected in the plan.
- New defects: UAT-035 (New Project with an empty target date leaves no milestones, major), UAT-036 (raw tier values on Approvals badges), UAT-037 ("(owner decision Q1)" in user-facing rationale), UAT-038 (High risk description omits expense deletions), UAT-039 (GitHub card intro still says a deployment completes a task). Fixed in the same evening; retest rows in `UAT-log/03-RETEST-SHEET.md`.

## Test data left on the local stack (not live)

Change requests CR-028..030 and the tester's emergency requests; two PATs (`change:*`, `change:decide`) not revoked; one expense with a pending deletion request; DOC-003 deletion request pending in a locked project; a regenerated weekly report for the week of 2026-10-12; Daniel Okoro briefly made admin and reverted.

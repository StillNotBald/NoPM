# Sprint Summary — 2026-10-18_audit-gaps

**TL;DR:** UAT cycle 1 closed (27 of 28 findings fixed and retested; 6 new minor/major items queued). Every PARTIAL / MISSING / STILL PRESENT item of the 2026-10-18 positioning audit built in four waves on `feat/audit-gaps-2026-10-18` (commits e05a691, 3576496, 693f299, f3e5682), 18 migrations (0088–0105), R-127..R-154, each wave reviewed once, fixed once, rehearsed on a local database, and gated. 

## Declared goals
- Close the audit gaps of `_docs/directions-2026-10-17/NOPM_AUDIT_REPORT.md` for the positioning "Your PMO runs without you, and leaves the evidence auditors ask for" (CR-2026-10-18-01, ADR 0016, ADR 0017). R-IDs: R-127..R-154.

## Actual outcomes
| Wave | Items | Migrations | R-IDs | Commit |
|---|---|---|---|---|
| 1 foundation | M7/K3 lock integrity, G6 backfill + VALIDATE, A7/K5 lean list views, K1 category deprecation, K2 impact_areas[], K4 preset + delete scopes, M5 access-review CSV, M3 export half | 0088–0091 | R-127..R-133 | e05a691 |
| 2 evidence chain | M2 implemented stamp (RPC), B1 decision↔CR link + structured options, B2 impact_scope, M4 evidence on documents, M3 audit pack CSV/PDF, B7 MCP reads | 0092–0094 | R-134..R-139 | 3576496 |
| 3 runs without you | M6 backup owners + handover report, A4 stale nudges, A3 weekly report, A5 change feed, B3 ETC/EAC + open commitments, B6 snapshots/trend/suggested RAG, G5 approver assignment, B5 project dependencies + contingency | 0095–0099 | R-140..R-147 | 693f299 |
| 4 governance | G1/G2/G7 tiers + routing + thresholds, G3 timers + routine auto-approve (off), G4 emergency path, G8 deletion by request for all records + DB backstop, M1 atomic audited writes (RPC + wrapper, 30+ handlers), M1 hash chain + verify, A1 GitHub work events | 0100–0105 | R-148..R-154 | f3e5682 |

Owner assumptions A1–A8 and decisions D1–D7 are recorded in `CHANGE-REQUEST.md`; they are built as stated and await her confirmation. Owner-visible changes: `OWNER-VISIBLE.md` (per wave). Reviews: `review/wave1.md`..`wave4.md` (0 P0 overall; every P1 and the data-integrity P2s fixed in one pass per wave).

## R-IDs touched
- R-127..R-154 → DONE (28 new rows in REQUIREMENTS + TRACEABILITY; `rtm:verify` OK, 144 R-IDs).

## Files
- Migrations `web/supabase/migrations/20261018000088_*` .. `..0105_*`; new libs under `web/src/lib/{api/views,audit/audited-write,audit/hash,governance/tiers,governance/timers,governance/request-deletion,handover,nudges,insight/snapshots,insight/trend,insight/project-contingency,changes,integrations/github,work/open,work/apply-task-status}`; new routes (implement, evidence, change-requests/decisions lists, evm, trend, contingency, dependencies, handover, weekly, changes, audit/verify, cron/snapshots, github events); new pages (handover, changes); OpenAPI + llms.txt updated every wave; UC-27..UC-34; CUTOVER/11.

## Tests / verification
- Gates per wave: tsc 0, vitest green except one pre-existing CRLF-checkout failure (final: 6649/6650), lint 0 errors, cli 68, commit-gate clean.
- Local-database rehearsals (`testing-log/2026-10-18_audit-gaps-wave1/README.md`): every wave's migrations dry-run + atomic over seeded data; functional probes of every new RPC/trigger; repo probes 9/9 and 29/29.
- UAT cycle 1 (`testing-log/2026-10-18_uat-cycle-1/`, `UAT-log/`): 82 plan steps run by two testers at 390 px + automated suites; 28 findings minted (0 blocker, 8 major), all fixed in one pass (commit dbead57) and retested: 27 CLOSED, UAT-017 REOPENED only for the checks that encode the open owner decision UAT-018, 6 new minor/major findings (UAT-029..034) left OPEN for cycle 2. Automated retest: Playwright 77/77, write journeys 13/13, every database probe green except the two UAT-018 replay checks.

## Follow-ups
- Owner confirmations: A1–A8, D1–D7 (CHANGE-REQUEST.md); nine wave-4 owner decisions in `review/wave4.md`.
- Release: CUTOVER/11 (0088–0105 in one `--atomic` run before the build; 0102 in the same window as the deploy; connect GitHub afterwards).
- Known limits: audit-chain head must be kept outside the database (printed on the weekly report + audit pack); historical self-approval rows are frozen; `in_review` maps to `started`; budget GET still sums expenses in one capped read (pre-existing).

## Cycle 2 (2026-10-18 evening) — owner decisions and cycle-1 leftovers

- Released first: PR #9 (waves 1–4 + UAT cycle 1) went live 20:09 MYT (migrations 0088–0105 in one atomic run, ledger 102, smoke 23/23, backup `pre-0088-20261018-2006`).
- Owner decisions recorded 20:15 MYT (end of `CHANGE-REQUEST.md`): A1–A8 and D1–D7 confirmed as built; Q1 emergency = flag only, no approval, no retro (supersedes UAT-034); Q4 approved documents on the manager tier; Q5 expense deletions at or above the threshold are high risk; Q7 no GitHub event completes a task; Q3/Q6/Q9 keep; Q2 and Q8 not built (Q2 wording awaits the owner; Q8 = anchor in a different database, planned as `sprint-log/2026-10-18_m1-closeout/`). UAT-018 still open.
- Built on `fix/uat-cycle-2-2026-10-18` by three builder agents (disjoint ownership) + one docs agent: R-155..R-160, migration `20261018000106_tier_decisions.sql` (emergency raise RPC in one transaction with both audit rows, trigger P0043 on who may raise, re-runnable data step `nopm_apply_tier_decisions()` that retires waiting retros, lowers approved-document deletions, raises expense deletions and rewrites stored GitHub `completed` rules with the real `before`), UI emergency flag in list/detail/queue/weekly report/audit pack, GitHub rules without `completed`, UAT-029..033 fixes.
- Review `review/cycle2.md`: 0 P0, 3 P1 (token scope on emergency raise, no database check on the raiser, non-atomic raise), 17 P2; one fix pass addressed all. C2-01 default built: an agent token needs the exact `change:decide` scope to raise an emergency (owner may relax).
- UAT cycle 2 (`testing-log/2026-10-18_uat-cycle-2/`): tester A 13 steps, retest runner 12 steps after the fix pass, runner C suites and probes; UAT-029..033 CLOSED, UAT-034 SUPERSEDED, new UAT-035..039 minted and fixed the same evening (see `UAT-log/`).
- Gates on the final tree: tsc 0, lint 0 errors, full vitest green (metrics regenerated, `--check` exit 0), rtm:verify OK (150 R-IDs), commit-gate clean, local 0106 rehearsal + probes 35/35 and 8/8.
- Re-audit against the positioning brief (`_docs\directions-2026-10-17\NOPM_AUDIT_REPORT_v2.md`, combined view `NOPM_AUDIT_COMBINED.md`): % BUILT A 14→86, B 14→86, G 13→88, M 14→57 (M1 re-rated PARTIAL: 24 write-then-audit stragglers + no external anchor).
- Release order for 0106: apply BEFORE the build serves traffic; `CUTOVER/11-AUDIT-GAPS.md` has the straggler query and the re-run note. After release run the read-only checks (constraint `convalidated`, nil-UUID locks, 0106 data-step counts, chain verify).

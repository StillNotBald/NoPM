# PLAN — 2026-09-07 OSS improvements wave (working state; resume from first unchecked item)

Owner (07:45): "yes, please do all now via multi-agent AI assistance; ensure requirements, sprint log, testing log are there; reverse-engineer use cases and BPD."
Previous sprint (2026-09-07_open-source-release) is STAGED, uncommitted; this wave stacks on top. Cron safety net: CronCreate "43 */2 * * *" — delete when done.

R-ID allocation (lead writes requirements/ at land — workers never touch requirements/, sprint-log/, testing-log/):
- R-88 one-command self-host: Dockerfile + docker-compose + `npm run setup` + Vercel deploy button; scripts env-first (worker A deploy-path)
- R-89 nonce-based CSP, no unsafe-inline for scripts (worker B csp-nonce)
- R-90 optimistic concurrency on entity PATCH: expected_updated_at → 412 (worker C occ)
- R-91 MFA login challenge for enrolled users (worker D mfa-login)
- R-92 contributor governance: issue/PR templates, dependabot, ROADMAP, contact link, demo copy, CLAUDE.md note (worker E repo-hygiene)
- R-93 reverse-engineered use-case catalogue (docs/use-cases) + 6 new BPD flows (docs/processes) (workers F use-cases, G bpd)

## Phases
- [x] W1 seven AI implementation workers in parallel (disjoint files) → reports/<name>.md
- [x] V1 adversarial verification (independent automated review) of high-risk: occ, mfa-login, csp-nonce, deploy-path; fix at land
- [x] L1 gates (tsc, vitest, lint, rtm:verify, gen-metrics, CLI, leak gate), RTM rows R-88..R-93 (REQUIREMENTS + TRACEABILITY same commit), ADR if needed
- [x] L2 testing-log/2026-09-07_oss-improvements/ evidence (gate outputs, verifier verdicts), SPRINT_SUMMARY.md receipt, memory update, CronDelete, final summary (NO commit/push)

## Log
- 07:45 folder + cron + 7 workers launched.
- 08:20 owner added: "greatly improve mobile UI" → R-94. Phases: M1 mobile audit (Playwright 390x844 + 360x800, demo login read-only, screenshots → testing-log/2026-09-07_mobile-ui/baseline) → M2 shell worker (layout/nav/panels/modal/tables primitives) → M3 page-group workers in parallel (registers / tracking / resources / governance / marketing+login) → M4 re-audit screenshots (after/) + evidence README. Use `next dev` on a spare port for audits while other agents may be building; NEVER two `npm run build` at once.
- 08:20 W1 all 7 reports in. V1: verify-occ CONFIRMED (no blockers); verify-deploy CONFIRMED (+ bootstrap append gap → fixed by lead: conditional replace-in-place); verify-csp CONFIRMED (+ CSP on request headers → fixed by lead); verify-mfa REFUTED 4 items → mfa-fix worker running (layout fail-closed, enrollment-bound cookie, atomic backup code, audit-before-cookie, guard tests). Lead added /auth/mfa/challenge to OpenAPI + llms.txt; RTM rows R-88..R-93 written (rtm:verify OK 83). Use-case diagram links fixed to ../processes/*-flow.html. cli-occ worker launched (--expected-updated-at on 5 update commands). SECRET-EXPOSURE NOTE: deploy-path worker printed web/.env.local values via `docker compose config` into its own transcript; tell owner (rotate or accept; NOPM_ENCRYPTION_KEY rotation invalidates BYOK keys + MFA secrets).
- 08:35 V1 done (mfa-fix landed: 1993 tests; cli-occ landed: CLI 33/33). M1 mobile audit done → testing-log/2026-09-07_mobile-ui/{FINDINGS.md (lead-compiled), baseline/, results.json}. The "N" FAB in dev screenshots = Next dev-tools indicator, not a defect. M2 mobile-shell worker running (sheet lock/inert/44px close, FilterSheet, DataList, field utility, text-2xs, PageHeader overflow menu, tap targets). NEXT: M3 five page-group workers (registers / tracking / resources / governance / marketing) adopting the primitives; M4 re-audit → after/ screenshots; R-94 RTM row; then L1/L2.
- 09:30 M3 five page-group workers done (2018 tests). M4 mobile-reaudit running (after/ + COMPARISON.md). Gates run: tsc ok, vitest 2018, lint 0 err, RTM 84/734, metrics fresh, CLI 33, leak gate 728 clean. R-94 row cites all page files. testing-log/2026-09-07_oss-improvements/README.md drafted. Memory: mobile-audit-eyes-and-shared-browser. REMAINING: build gate after re-audit kills dev server → SPRINT_SUMMARY → PLAN check-offs → CronDelete 6aa811fe → final summary.
- 10:20 M4 re-audit done (F1-F9 fixed, no regressions; residual task deep link fixed by lead + live-checked; assistant close 44px). Build green. ALL PHASES DONE. Receipt written; cron 6aa811fe deleted. NOT committed/pushed (owner).

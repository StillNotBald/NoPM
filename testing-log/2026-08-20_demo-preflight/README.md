# 2026-08-20 — full-battery demo pre-flight (CTO/PMO demo readiness)

Status: **ACTIVE** (closed record — immutable per the evidence-tree contract in `testing-log/README.md`)

Purpose: pre-demo verification that every test surface is green **on the live target** before an external demo (CTO + PMO-lead audience). This is the first entry to run the full battery — unit, typecheck, RTM gate, e2e-vs-live, live funnel probe, and a screenshot/timing pass — in one sitting.

## What ran, and results

| Surface | Command | Result |
|---|---|---|
| Unit + security suites (vitest) | `cd web && npm run test` | **1,718 passed / 0 failed** (72 files, 3.9s). Includes the security-relevant suites: workspace isolation, `auth/guard`, scope registry, assistant token ceiling, crypto round-trip, OpenAPI drift locks. |
| Typecheck | `cd web && npx tsc --noEmit` | Clean. |
| RTM gate | `cd web && npm run rtm:verify` | **67 R-IDs status-matched, 432 code-file paths verified on disk.** |
| Playwright e2e (Tier 1, read-only) vs **live** | `cd web && BASE=https://stillnotbald.com npx playwright test` | **77 passed / 0 failed / 12 skipped** (1.3m). The 12 skips are the Tier-2 write journeys, deliberately gated off (`E2E_WRITES` unset) — they would write to the shared live demo workspace hours before a demo. |
| Authed page-render smoke vs live | `cd web && node scripts/auth-smoke.mjs` | **23/23** pages 200 as admin. Doubles as the Supabase free-tier keep-alive. |
| Funnel-identity probe vs live | landing → `POST /api/auth/demo-login` → `/dashboard` → `/api/me` | 200 → 302 → 200; demo identity is **"Demo Visitor", role `manager`** (the write wow-moments work — the entry-path identity, not just admin, per the funnel-identity lesson). |
| Screenshot + timing pass vs live | headless Chromium as the **demo identity** (clicked the real "Try the live demo" button) | 23 console pages + landing captured full-page at 1440×900; every page rendered with data (no error boundaries, no convincing-empty-states). Slowest full `networkidle` loads: `/sprints` 2.9s, `/mainline` 2.3s, `/my-tasks` 2.1s; everything else 1.0–2.1s. |

## Where the raws are

Screenshots + `timings.json` live in `nopm-pitch-assets/screens/e2e-2026-08-20/` — **gitignored by design** (rule 3: raws are regenerable; the capture script is a ~50-line Playwright loop over the auth-smoke page list, re-derivable from this description). Vitest/Playwright/RTM outputs are re-derivable from the commands above.

## Honest gaps (unchanged by this run)

- **No performance/load-test suite exists.** The timing column above is a single-client page-load measurement over the public internet, not a load test. Known-unaddressed scale items remain on record in the 2026-08-14 assessment (indexes partially landed in wave-1a; no OCC).
- **Security coverage = unit suites + CI `dependency-audit`/`secrets-scan`.** No external penetration test has ever been run against the live target.
- Tier-2 write journeys were **not** exercised in this run (deliberate, pre-demo); their last full pass is on record in `sprint-log/2026-08-14_maker-withdraw/SPRINT_SUMMARY.md`.
- The `MISSING` rows in this log's journey→coverage index are unchanged by this run.

## Operator

Owner (Chu Ling) + AI session (demo-prep session, 2026-08-20).

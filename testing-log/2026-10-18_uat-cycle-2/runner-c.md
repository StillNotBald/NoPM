# Runner C — automated suites and probes, UAT cycle 2

The original runner-C agent was lost when the machine had to be restarted at 22:49 MYT (out of virtual memory; see the cycle README). The lead re-ran the sweep sequentially at 23:00–23:10 MYT against the restored local stack (ledger 103, last file 0106) and the dev server started with the cycle-2 env (`DEMO_EMAIL=demo@example.com`, fake Lark override). Logs: `runner-c/*.log`. `BASE=http://localhost:3000` for every command; nothing touched the live site.

| Suite | Pass | Fail | Classification |
|---|---|---|---|
| `tsc --noEmit` (final tree) | 0 errors | | |
| `npm run lint` (final tree) | 0 errors | 15 warnings | PRE-EXISTING warnings |
| vitest full suite via `gen-metrics.mjs` (final tree, run alone) | all | 0 | metrics regenerated; `--check` exit 0 |
| `auth-smoke.mjs` (local) | 23 | 0 | |
| `probe-migrations` | 9 | 0 | |
| `probe-four-eyes` (T1–T6 new in cycle 2) | 35 | 0 | |
| `probe-rls-direct-write` | 23 | 0 | |
| `probe-api` | 13 | 2 | OPEN-DECISION: API8 and API11 both expect a replayed approve/decide to answer 422; the product answers 200 `{committed: true}` (idempotent). This is UAT-018, still awaiting the owner. |
| `probe-calendar` | 10 | 0 | |
| `probe-lark` (fake Lark) | 51 | 0 | |
| `probe-github` (GH4 now asserts a deploy never completes a task, Q7) | 8 | 0 | |
| CLI contract tests (`cli/`, `node --test`) | 68 | 0 | |
| Cron endpoint `GET /api/integrations/cron` | 200 | | summary has no retro or overdue-emergency counters; approvals examined 88, autoApproved 0 |
| Playwright tier 1 (read journeys, 1 worker) | 45 | 0 (13 skipped: opt-in specs) | run 23:15–23:36 MYT against the dev server |
| Playwright tier 2 (`E2E_WRITES=1`, 1 worker) | 75 | 9 | ENV: all nine are read-only page journeys (dashboard, demo login, dialogs, navigation, wizard absence, tokens surface) that PASSED in tier 1 twenty minutes earlier; tier 2 ran 23:37–23:42 MYT while three wave-5 builders were editing `web/src` under the same dev server, which forces full page reloads mid-test. Every write journey that tier 2 exists for passed. Re-run with a quiet tree before release if wanted. |


## Defects (PRODUCT)

None from this sweep. The two probe-api failures are the open owner decision UAT-018, not defects.

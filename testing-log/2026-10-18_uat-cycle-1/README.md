# 2026-10-18 — UAT cycle 1 (audit-gap programme, branch feat/audit-gaps-2026-10-18 @ f3e5682)

Environment: Next dev server on localhost:3000 against the local Supabase stack (migrations 0001–0105, bootstrap + seed:all), Playwright (isolated Chromium) at 390×844 and 1280×800. Three runners: tester A (waves 1–2 screens), tester B (waves 3–4 screens), runner C (automated suites and probes). Defects were written to `UAT-log/_intake/*` and triaged into `UAT-log/01-FINDINGS.md` / `02-ROOT-CAUSES.md` (IDs minted there only; this file holds the counts).

## Step results

| Runner | Steps | PASS | FAIL | BLOCKED | Report |
|---|---|---|---|---|---|
| Tester A (waves 1–2) | 39 | 23 | 3 | 13 | `tester-a-waves-1-2.md` |
| Tester B (waves 3–4) | 43 | 29 | 4 | 10 | `tester-b-waves-3-4.md` |

Blocked steps were almost all caused by the test environment, not the product: `DEMO_EMAIL` was set to the admin account, which the app treats as the restricted demo identity (no token minting, no invites), so no manager or member identity and no second human approver was available. Aged or overdue records (stale nudges, retro-overdue emergencies) could not be created. Cycle 2 must start the server with a separate demo user and a Lark override.

## Automated (runner C)

| Suite | Pass | Fail | Classification of failures |
|---|---|---|---|
| auth smoke (local) | 23 | 0 | |
| Playwright full (sign-out test excluded) | 69 | 8 | stale selectors (tabs are now `role="tab"`), demo-restricted writes |
| Playwright write journeys (E2E_WRITES=1) | 9 | 4 | demo-restricted token/invite writes |
| probe-migrations | 9 | 0 | |
| probe-four-eyes | 29 | 0 | |
| probe-rls-direct-write | 23 | 0 | |
| probe-calendar | 10 | 0 | |
| probe-api | 13 | 2 | probes lack the now-required `expected_updated_at` (stale fixtures); approval replay via token returns 200 (needs owner triage: idempotency) |
| probe-lark | 34 | 17 | no Lark override on the dev server (16 LK-EM* checks); one connector check reached a real Lark host with a fake credential |
| probe-github | 5 | 3 | GH4 = product defect (deploy event writes NULL task status); GH3/GH6 stale fixtures |
| cron endpoints | 2 | 0 | both 200 with clean summaries |

## Incidents during the run (no data changed)
- Runner C's first auth-smoke run targeted the live site with read-only GETs before `BASE` was set; re-run against localhost.
- The Playwright demo sign-out test revokes every admin session; it logged the other runners out around 16:40–16:55 MYT and was excluded from the clean passes.
- Tester B changed one seed value (CDP-CORE forecast: to-finish 600000, bottom-up). Nothing was deleted.

## Headline product defects (details and IDs in UAT-log)
- Deployment success after a merge never completes the task: the label clear writes NULL into `tasks.status` (reported by tester B and runner C).
- Evidence fields missing from the document viewer and the New Document form.
- Notification bell shows "all caught up" while unread weekly-report notifications exist.
- Raise change request form lacks the tier select and Emergency tick; waiting requests show no tier badge or deadline.
- Risks, issues, expenses and documents have no "Request deletion" button in the UI.
- Link PR saves but the task panel shows nothing on reopen.
- Editing a project with no programme fails ("Invalid project data", `program: null`).

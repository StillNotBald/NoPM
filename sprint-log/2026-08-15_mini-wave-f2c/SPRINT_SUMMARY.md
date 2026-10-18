# Sprint summary — F2c mini-wave (demo + close the loop)

**Date:** 2026-08-15
**Intent:** Owner-locked pivot after F2b: F3 killed as a wave ("does it change what a hiring manager sees?" test — 8 rows deferred, ADR 0010), Wave-3 infra fulfilled as **documentation** not code, and the load-bearing/demo-funnel remainder built as one lean mini-wave. New R-IDs: **R-76** (period-close lock, L-32) + **R-77** (governance tour, L-50, + demo seed extending R-52). Funnel fixes land under existing umbrellas.
**Mode:** LEAN (now the default): 5 sequential AI build passes, adversarial verification ONLY on T1 (the governance task) — **0 of 3 independent review passes disputed the result**.

## What shipped

- **R-76 period-close lock** — approved timesheet freezes its member-week: route 422 guards on time-entry create/delete + DB backstop trigger (`P0011`, no bypass GUC, service-role-only execute); governed `reopened` third decision verb (approved-only, rationale required, self-reopen 403 — guard symmetry across all three verbs; reverts to `submitted`, re-notifies approvers, one `timesheet.reopened` audit row); locked-week markers on the grid + submit panel.
- **R-77 governance tour + demo seed** — dismissible 5-stop deep-link checklist on the dashboard for every role (Trust Center / Review Queue / Sprints / lock-rebaseline / connect-agent), visited+dismissed state on the new `tour` preferences key (demo identity never persists); `seed-sprints-timesheets.mjs` (purge-first, re-runnable, in `seed:all`): 2 closed + 1 active sprint with back-dated audit transitions so burndown/velocity draw real lines, time entries for 3 members, pending/approved/rejected submission trio — pending submitted by a non-demo actor so the demo login can be the second pair of eyes; approved one demos the R-76 lock.
- **Funnel fixes** — `/login` reads `?email=` (Suspense + lazy state init, no set-state-in-effect); connect-agent pointer restored for viewers and wizard-dismissers; invite-accept API collapsed to ONE uniform 422 for not-found/expired/used/revoked (anti-enumeration; `email_exists` stays distinct — caller already holds a valid token; the public page keeps friendly per-status copy, asymmetry documented); search gains `program` (→ `/portfolio#id` real anchor) + `sprint` entities incl. command-palette icons; export gains `entity=programs`; case-study copy now covers sprints, timesheet four-eyes/reopen, and link invites.
- **Wave 3 as documentation** — `docs/SELF_HOSTING.md` (documented-not-shipped topology, env matrix, honest not-supported list, cross-linked to the CUTOVER stubs), `docs/DR_RUNBOOK.md` (executable PITR drill: restore→repoint→auth-smoke→immutability-trigger check→RTO log; free-tier caveats + pause-outage lesson), `docs/adr/0010-f3-deferral-and-infra-as-documentation.md` (8 deferred rows with per-row rationale — the ADR corrects my "9 rows" to the mechanically-derived 8, since L-50 was F1-tagged all along; infra "fulfilled as documentation", not withdrawn).

## Verification

- T1 adversarial verify: **0/3 refuted** — verifiers independently confirmed the P0011 errcode matches between SQL and TS mapper, both triggers (INSERT/DELETE split — Postgres NEW/OLD rule), no bypass GUC, route guards ordered after workspace verification.
- Gates at land: tsc clean · **72 files / 1,718 unit tests green** · lint 0 errors (1 pre-existing unrelated warning) · `rtm:verify` **67 R-IDs, 432 paths**.
- Worker-flagged items accepted at land: `assertWeekUnlocked` fetches member's approved rows then filters in JS (member_id is workspace-unique via FK; fine at demo scale, noted for future server-side range filter); no Review Queue "reopen" button (API-only verb this wave — flagged as a possible future UI entry point).

## Owed / follow-ups

- Reopen verb has no UI trigger (deliberate this wave).
- Lean e2e debt from F2b still stands (wizard/invite-accept happy paths etc.).
- DR runbook is executable but the drill itself has NOT been run — running it once and logging the RTO entry is the remaining infra credibility step (paid-tier PITR precondition applies).

## Land evidence

- Commit: `b42a6e1` (feat, 44 files, +2,147/−130) — RTM R-76/R-77 same-commit (`rtm:verify`: 67 R-IDs, 432 paths).
- Migration 040 applied to live Supabase + PostgREST reload.
- Seed run (live): 2 closed sprints (29/21, 38/38 committed/completed) + 1 active (55 pts, 8 tasks), 3 back-dated burndown transitions, 14+ time entries across 3 members, submission trio (Priya rejected→resubmitted-pending, Daniel approved→week locked).
- Deploy: `vercel deploy --prod` READY → stillnotbald.com; health 200; auth-smoke **23/23**.
- Live probes (**13/13**, demo state restored afterwards): create/delete entry in Daniel's APPROVED week → both **422 (lock live)**; reopen without rationale 422 → reopen with rationale **200** (back to submitted) → entry create then worked (201, rolled back) → **re-approved 200** (lock restored for the demo); accept unknown invite token → **uniform 422** (anti-enumeration live); search returns `sprint` entities; `export?entity=programs` 200 CSV; `/api/sprints` shows the 3 seeded sprints; dashboard renders the governance tour; `/login?email=` 200.

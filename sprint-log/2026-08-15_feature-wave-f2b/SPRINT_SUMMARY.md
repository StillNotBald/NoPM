# Sprint summary — F2b feature wave (sprints & flow, timesheets four-eyes, wizard, link invites)

**Date:** 2026-08-15
**Intent:** Land F2b — 12 lite-register rows: sprints + commitment snapshot + burndown + velocity (L-17/18/19/20), cycle/lead time + time-in-status API (L-22/24/26), time report + weekly timesheet grid + timesheet four-eyes (L-28/30/31), first-run wizard (L-45), link invites + unified identity (L-47/48). New R-IDs: **R-73/R-74/R-75**.
**Mode:** LEAN (owner-locked this session after the token-spend review of the 2026-08-14 marathon): 8 sequential AI implementation agents, adversarial verification ONLY on the two governance builds (T5 timesheet four-eyes, T7 link invites), trimmed e2e set. Cross-model verifier skipped both times (no OpenRouter key) — verdicts rest on 3 Claude-family independent reviewers each.

## What shipped

- **R-73 Sprints + flow metrics** — migration `037_sprints` (sprints table + `tasks.sprint_id`), `/api/sprints` CRUD + governed `start`/`close` transitions with frozen points snapshots + task attach/detach (all audited), `/sprints` page (project-grouped list, overlap flag, burndown with working-day ideal line, velocity with rolling 3-average, Flow card with cycle/lead median+p85 and exclusion counts), `GET /api/metrics/time-in-status` — all analytics pure functions over `audit_log` full before/after snapshots, zero new columns.
- **R-74 Timesheets** — `date_from`/`date_to`/`billable` filters on time-entries (export inherits via shared parser), `/timesheets` page (weekly grid with 0-vs-— distinction + capacity, filtered time report with snapshot-cost-only totals + /budget reconciliation caption, first log-time form in the product), migration `038_timesheet_submissions` (change-request template: `ts_maker_checker` CHECK + partial-unique open-submission index), submit + decision routes with compound (id,type) self-decision guard → **403 on both approve and reject**, rationale-required-on-reject, Review Queue fifth governed kind `timesheet` + inline decide, `time:submit`/`time:approve` scopes with agent-ceiling tests.
- **R-75 Onboarding** — first-run wizard (empty-workspace + canWrite gate, existing-APIs-only, resumable/dismissible via new `onboarding` preferences key, demo never persists), migration `039_invites` (deny-all RLS, SHA-256 `npi_` tokens, 7-day expiry) + `nopm_accept_invite` SECURITY DEFINER fn (FOR UPDATE, typed P-codes, atomic profiles+resource_members+invite-mark+2 audit rows), create/list/revoke restricted to admin/manager user sessions with role-escalation cap (≤ creator rank), unauthenticated accept with explicit IP rate-limit + createUser-first + orphan-cleanup (failure-injection unit-tested), public `/invite/{token}` page, invites card on /settings.
- **D12 defect fix** — `api/tasks/[id]/route.ts` deletion-notification title read `task.title` (column doesn't exist → rendered a raw UUID); now `task.name`. (Typed-but-absent class, found by recon.)

## Verification

- **Adversarial verify (high-risk only):** T5 timesheet-four-eyes **SURVIVES 0/3 refuted**; T7 link-invites **SURVIVES 0/3 refuted**. Verifiers independently re-ran suites, re-read migrations/guards line-by-line, confirmed: guard symmetry real, deny-all RLS real, no invite scope mintable on PATs, `time:approve` unreachable by agent preset + assistant tools, failure-injection test genuine, GET-invites status filter correctly pushed into the query pre-pagination (a real bug the worker caught and fixed itself).
- **Gates at land:** tsc clean · vitest **69 files / 1644 tests green** · lint **0 errors** (main session fixed T4's 4 errors post-wave: 2× set-state-in-effect refactored to derived-loading/onChange-reset patterns, 2× unescaped apostrophes; 1 pre-existing unrelated warning remains in `openrouter.test.ts`) · `rtm:verify` **65 R-IDs, 413 paths**.
- **Worker-flagged interpretation calls (accepted at land):** closed sprints freeze the whole PATCH (not just dates); sprint task attach 422s (not 404s) on unknown task; D5 role cap implemented as canonical ≤-rank (a manager CAN mint a manager — the task-body elaboration saying otherwise was the spec's own inconsistency, disclosed by the worker); `/invite/[token]` page reads via admin client directly (deny-all RLS makes a session read impossible — narrow documented exception to "UI only calls the API"); e2e write journeys gated behind `E2E_WRITES=1` per the repo's two-tier convention.

## Owed / follow-ups (lean-mode debt, explicitly tracked)

- E2E journeys skipped this wave: velocity deep journey, flow-card-with-real-transitions, time-report filter journey, log-time-form journey, wizard happy-path, invite-accept happy-path, role-escalation-cap negative e2e (unit-covered).
- `/login` doesn't consume the `?email=` prefill hint the accept form passes.
- Empty-dashboard "connect an agent" pointer now lives only inside the wizard's final step — viewers and early-dismissers lose the link (spec-conformant; owner may want a light permanent pointer back).
- reference-project overlap audit (this session) suggests unifying invite-accept error responses (uniform 400 anti-enumeration) — current distinct 404/422s are safe (32-byte CSPRNG tokens) but the uniform shape is strictly better; candidate for F3.
- Sidebar + review-queue pre-existing `text-[11px]` literals — batch design cleanup candidate.

## Land evidence

- Commit: _pending_
- Migrations applied: _pending_
- Deploy: _pending_
- auth-smoke: _pending_
- Live probes: _pending_

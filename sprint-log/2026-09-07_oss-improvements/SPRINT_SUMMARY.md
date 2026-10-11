# Sprint Summary — 2026-09-07_oss-improvements

**TL;DR:** The post-publication improvement wave: one-command self-host, nonce CSP, optimistic concurrency, MFA at login, contributor governance, a reverse-engineered use-case catalogue with six new process diagrams, and a full mobile pass over 29 routes. Seven build workers, one CLI worker, six mobile workers, five adversarial verifiers and one re-audit, all AI-assisted, on disjoint file sets; every high-risk change was refuted-or-confirmed against the real code before landing. R-88 … R-94 added; RTM verifies with 84 R-IDs. Working tree is gated and **not committed** (owner action, together with the earlier open-source release changes).

## Declared goals (owner, 2026-09-07 07:45 and 08:20)
"Do all" of the improvement list from the release review; make sure requirements, sprint log and testing log exist; reverse-engineer use cases and BPDs; greatly improve the mobile UI.

## Outcomes by requirement

| R-ID | What shipped | Verification |
|---|---|---|
| R-88 | `npm run setup` (migrate → PostgREST reload → bootstrap → optional seed; `--dry-run`), `web/Dockerfile` + `docker-compose.yml`, Vercel deploy button, all ops scripts env-first via `scripts/lib/env.mjs`, `reseed.yml` no longer writes a temp `.env.local` | verifier CONFIRMED: independent `docker build` (306 MB, uid 1001, `/api/health` 200), dry-run makes no network call; one gap (bootstrap appended stale tokens to `.env.local` on rerun) fixed by the lead |
| R-89 | Per-request nonce CSP, no `unsafe-inline` for scripts; CSP also forwarded on the request; `strict-dynamic` deliberately omitted for the edge-injected Cloudflare beacon; matcher covers `/api/**`; ADR 0011 amended | verifier CONFIRMED on the standalone production server: one CSP header per response class, fresh nonce per request, 0 console violations on 4 pages incl. authenticated dashboard |
| R-90 | Optional `expected_updated_at` on the five entity PATCH routes → 412 with `current_updated_at`; conditional UPDATE closes the read→write race; OpenAPI, llms.txt, MCP registry, five edit forms, CLI `--expected-updated-at` (33/33 CLI tests) | verifier CONFIRMED, live V8 checks on ms-equality; two cosmetic caveats recorded (`.maybeSingle()` error text; 412 precedes the lock 422) |
| R-91 | MFA challenge at login, fail-closed in `requireAuth` for session actors, signed enrollment-bound cookie, atomic backup-code consumption, audit before credential, console layout fail-closed | verifier REFUTED four items; all fixed the same hour, plus a latent bug (disable wrote `null` into a NOT NULL column); guard tests 23 → 35, mfa tests 19 → 24 |
| R-92 | Issue forms (bug / change request / feature), PR template with the constitution's checklist, Dependabot, `docs/ROADMAP.md`, landing "Raise a change request" link (`NEXT_PUBLIC_CONTACT_URL`), CONTRIBUTING sections, CLAUDE.md pointer | structural (YAML parsed and shape-checked) |
| R-93 | `docs/use-cases/` (README + 22 use cases with exact touchpoints, scopes, exception flows, audit actions) and six new BPMN-style diagrams in `docs/processes/` (8 total, index README, regeneration rule); one engine bug found (branch off a step node produces NaN) and worked around | all 8 diagram links resolve; each diagram > 10 KB, contains `<svg`, 0 headless console errors; unconfirmed details carry `[UNVERIFIED]` |
| R-94 | Mobile console: sheets lock scroll, inert the shell, manage focus, 44 px close, sticky footer; `FilterSheet`, `DataList`, PageHeader overflow menu, `field` and `text-2xs` utilities, 44 px hit areas; five page groups adopted them (registers as cards, dashboard controls fixed, tasks/my-tasks cards + filter sheet, project header overflow menu, board snap-scroll + tap-to-open, timesheet day list, budget/resources cards, Trust Center cards + filter sheet, tokens accordions, landing hamburger sheet, 44 px login controls) | baseline vs re-audit: 0 document overflow before and after on 29 routes × 2 viewports; unwrapped wide tables 15 → 3 (all scroll-wrapped); sub-40 px interactive elements 308 → 211 (remaining are documented off-canvas false positives and dense chips); every baseline finding F1–F9 fixed and live-verified; no regressions, no console errors; the one real residual (task tap on `/tasks` opened nothing, pre-existing) fixed by the lead and live-checked |

## Gates (final)
tsc clean · vitest **2018/2018** (90 files) · eslint 0 errors · `rtm:verify` OK (84 R-IDs, 735 paths) · `gen-metrics --check` fresh · CLI 33/33 · leak gate 728 tracked files clean · `npm run build` green (all routes dynamic).

## Evidence
`testing-log/2026-09-07_oss-improvements/README.md` (gate battery + verdict index) · `testing-log/2026-09-07_mobile-ui/` (FINDINGS, COMPARISON, baseline/after screenshots, results JSON) · `reports/` in this folder (7 worker reports, 5 verifier verdicts, 6 mobile reports, re-audit).

## Decisions and deviations worth knowing
- `strict-dynamic` not used: Cloudflare injects its beacon at the edge without our nonce; a host allow-list keeps it working (the 2026-09-05 regression class).
- Landing nav is now a hamburger sheet below `md`; an older test that locked "pure CSS nav, no hamburger" was rewritten deliberately.
- DataList adoption changed desktop table padding by a few pixels on register pages (disclosed by the registers worker).
- Change-request approval is record-only (no auto-apply) and documents have no four-eyes step; the diagrams state these plainly instead of inventing behaviour.
- MFA lookup failure at the API layer surfaces as a 500 (fail-closed by rejection), not a 401.

## Incident
The deploy-path worker ran `docker compose config` (non-quiet), which printed every `web/.env.local` value into that agent's local session transcript. Nothing left the machine; the owner decides whether to rotate (service-role key, DB password, demo tokens; note `NOPM_ENCRYPTION_KEY` rotation invalidates stored BYOK keys and MFA secrets). `docs/SELF_HOSTING.md` now warns to use `--quiet`.

## Owed / next (owner)
1. Commit both same-day sprints in one commit (RTM same-commit rule), then follow `sprint-log/2026-09-07_open-source-release/PUBLISH_RUNBOOK.md` (recreate repo → rename → secrets → public → branch protection → deploy).
2. After deploy: run the weekly smoke, open a PDF in `/documents` (CSP + frame headers), sign in with an MFA-enrolled account once to see the challenge, try `nopm tasks update … --expected-updated-at`.
3. Minor mobile residuals: `/projects` list as cards, `/tokens` scope accordion above the list, dashboard title beside the wide export button, review inspector real footer slot via `useInspector`.
4. Decide on the secret-rotation question above.

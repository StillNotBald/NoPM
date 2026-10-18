# Testing log — 2026-09-07 OSS improvements wave (R-88 … R-94)

Evidence for the release-readiness improvements built after the Apache-2.0 publication prep. Every feature was built by a worker on a disjoint file set, then adversarially verified by a second agent against the actual code before landing; the verdict files are the primary evidence and are listed per row. Owner + AI session; nothing here was run against production data except read-only demo sign-ins during browser checks.

## Gate battery (final, working tree at land)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `cd web && npx tsc --noEmit` | clean |
| Unit + invariant tests | `cd web && npx vitest run` | 2018 passed / 2018 (90 files) |
| Lint | `cd web && npx eslint` | 0 errors, 1 pre-existing warning |
| RTM integrity | `npm run rtm:verify` | OK, 84 R-IDs, 734 code paths verified on disk |
| Generated metrics | `node scripts/gen-metrics.mjs --check` | fresh |
| CLI contract tests | `cd cli && npm test` | 33 passed / 0 failed |
| Leak gate (all tracked) | `node scripts/commit-gate.mjs --all` | 728 tracked files clean |
| Production build | `cd web && npm run build` | see "Build" below |

## Per-requirement evidence

| R-ID | Feature | Worker report | Verifier verdict | Extra evidence |
|---|---|---|---|---|
| R-88 | One-command self-host | `sprint-log/2026-09-07_oss-improvements/reports/deploy-path.md` | `reports/verify-deploy.md` — CONFIRMED; one gap (bootstrap token append) fixed by the lead | `docker build` 306 MB non-root image, container `/api/health` 200 with fake env; `setup.mjs --dry-run` zero network calls |
| R-89 | Nonce-based CSP | `reports/csp-nonce.md` | `reports/verify-csp.md` — CONFIRMED; CSP now also on request headers | production build, one CSP header per response, fresh nonce per request, 0 console violations on `/`, `/login`, `/case-study`, `/dashboard` |
| R-90 | Optimistic concurrency | `reports/occ.md`, `reports/cli-occ.md` | `reports/verify-occ.md` — CONFIRMED (two cosmetic caveats recorded) | `occ.test.ts`; drift locks (tools-zod, openapi-coverage, llms-coverage) green; CLI 33/33 |
| R-91 | MFA challenge at login | `reports/mfa-login.md`, `reports/mfa-fix.md` | `reports/verify-mfa.md` — 4 REFUTED items, all fixed (console fail-closed, enrollment-bound cookie, atomic backup code, audit before cookie) | guard.test.ts 35, mfa.test.ts 24; `next build` shows `/api/auth/mfa/challenge` |
| R-92 | Contributor governance | `reports/repo-hygiene.md` | structural (YAML parsed, schema shape) | n/a |
| R-93 | Use cases + BPDs | `reports/use-cases.md`, `reports/bpd.md` | link check: all 8 diagram links resolve; every diagram > 10 KB, contains `<svg`, 0 console errors headless | `docs/use-cases/`, `docs/processes/` |
| R-94 | Mobile console | `reports/mobile-shell.md` + five page-group reports | `testing-log/2026-09-07_mobile-ui/COMPARISON.md` (re-audit) | baseline vs after screenshots, `results.json` vs `results-after.json` |

## Build

`npm run build` green after the mobile wave and the task deep-link fix: every route renders dynamically (ƒ), proxy middleware present, no warnings. The task deep link was then live-checked at 390×844 on a dev server (`testing-log/2026-09-07_mobile-ui/after/iphone/tasks_deeplink_panel.png`).

## Known residuals (not blocking)

- Dashboard title truncates beside the wide "Export board pack" button on 390 px phones (cosmetic).
- /projects list table still a scroll-wrapped table on phones (not converted to cards); /tokens first data row sits at ~1000 px because the scope accordion precedes it.
- Portfolio page title truncation and the My Work "Hot now" strip clipping trailing chips (tracking worker's disclosed gaps).
- Review inspector's decision bar mimics a sticky footer; the real panel `footer` slot is not wired through `useInspector` in `app-shell.tsx`.
- Landing nav is now a hamburger sheet, superseding an older test that locked "pure CSS nav, no hamburger" (owner asked for a strong mobile pass; the test was rewritten to the new behavior).

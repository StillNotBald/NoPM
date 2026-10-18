# Testing Log — evidence tree

Status: **ACTIVE**

## The contract

`testing-log/` is where test **evidence** lives — the record that a run happened, what it proved, and what gaps it surfaced. It is not where the tests themselves live (that's `web/` — vitest suites beside the code, Playwright specs in `web/e2e/`, smoke scripts in `web/scripts/`).

Rules, same discipline as `sprint-log/`:

1. **Dated, immutable folders.** Every entry is `testing-log/<YYYY-MM-DD>_<slug>/`. Once written, a folder is never edited to change its findings — it is history.
2. **Re-runs get new folders, not overwrites.** Running the same suite again next week produces `testing-log/<new-date>_<same-or-new-slug>/`, not an edit to the old one. If a later run contradicts an earlier one, the later folder says so explicitly and links back; it does not erase the earlier record.
3. **Summaries are the evidence; raws are regenerable.** Each dated folder's `README.md` (or `SUMMARY.md`) is the artifact that matters — what was run, what it proved, operator, method, gaps. Raw output (console logs, screenshots, JSON) may be attached alongside it, but nothing here depends on raw artifacts surviving — every claim in a summary must be re-derivable by re-running the command it names. Do not commit large/binary raw captures; commit the summary and, where useful, a short pasted tail.
4. **One status lives in exactly one file.** This README indexes; it does not restate pass/fail counts that live in a dated folder or in a `sprint-log/` receipt — it links to them.
5. **Honesty over completeness.** Where no suite covers a journey, the index says `MISSING`. A gap that is written down is a known gap; a gap that is hidden by silence is a live risk.

## What already exists (index)

This section points at the test surfaces that exist today, in `web/`. It does not re-describe their internals — see the file itself for the authoritative content.

### Unit tests (vitest)

- **Location:** co-located `*.test.ts` files across `web/src/**`.
- **Run:** `cd web && npm run test`
- **Current count:** 1,063 tests (40 files) — see `sprint-log/2026-08-14_devops-wave1a/SPRINT_SUMMARY.md` for the count at that wave's close; re-run the command above for the live number, since this index is not the count's source of truth.
- **CI:** `.github/workflows/ci.yml`, job `verify` (typecheck → unit tests → RTM integrity → generated-metrics freshness), on every push/PR to `main`.

### Playwright e2e (`web/e2e/`)

- **Location:** `web/e2e/*.spec.ts`
- **Run:** `cd web && npm run e2e` (Tier 1, read-only, default). Tier 2 (write journeys) requires `E2E_WRITES=1` plus a checker PAT (`NOPM_CHECKER_TOKEN` in `web/.env.local` or CI env).
- **Auth:** `web/e2e/global-setup.mjs` mints a real admin session (same generateLink→verifyOtp→cookie technique as `scripts/auth-smoke.mjs`) into Playwright storage state (`web/e2e/.auth/admin.json`, gitignored). Specs `test.skip` themselves if that file doesn't exist (no Supabase env available).
- **Spec files (8):**

| Spec | Covers |
|---|---|
| `public.spec.ts` | Unauthenticated surfaces: landing hero (demo entry + sign-in link + case-study link), `/login` renders (demo card + email/password form), wrong-credentials shows an inline error (not a crash). |
| `demo-login.spec.ts` | The public funnel's wow-moment: clicking "try the live demo" lands authenticated on `/dashboard`; the demo identity can browse `/projects`, `/risks`, `/trust`; sign-out actually kills the session (bounces back to `/login` on a re-visit). |
| `navigation.spec.ts` | Global chrome: sidebar navigation between console sections, command palette (⌘K opens/filters/closes/navigates). |
| `console-pages.spec.ts` | Every one of the 19 console pages renders with its shell + primary action visible and no error boundary — the browser-level descendant of `auth-smoke.mjs` (which only checks HTTP 200, not that the button is actually there). |
| `dialogs.spec.ts` | Every "New X" / "Add X" entry button opens its form in the right push-panel and cancels cleanly without writing: New Project, New Risk, New Issue, Add Decision, Raise Change Request, New Document, Add Team Member, Export board pack menu (format list), mint-token form presence. |
| `project-detail.spec.ts` | The richest page (`/projects/[id]`): all 8 tabs (Charter, Overview, Activity, Board, Gantt, Risks, Issues, History) render, Edit/Lock controls visible, every tab switches without an error boundary. |
| `writes.spec.ts` (Tier 2, opt-in) | Full governed journey end to end: create project → task → status transition (PATCH) → maker-checker delete request → self-approve blocked (403/422) → self-reject blocked (422, guard symmetry) → withdraw (200) → re-withdraw blocked (422, terminal) → re-request after withdraw → foreign (checker) withdraw blocked → checker rejects → cleanup. Plus: mint + revoke a PAT through the `/tokens` UI. |
| `global-setup.mjs` / `helpers.ts` | Not tests themselves — the admin-session minting fixture and the `SHELL_MARKER` / `ADMIN_STATE` constants every other spec depends on. |

- **CI:** not wired into `ci.yml` (needs live Supabase env + a minted session); no dedicated e2e-on-push workflow exists today. It runs locally and is exercised at wave-close live verification (see the dated entries below). **This is a documented gap, not silently missing** — see the journey table's CI column.

### Auth-smoke (`web/scripts/auth-smoke.mjs`)

- Authenticated page-render rehearsal against a **live** target (defaults to `https://stillnotbald.com`; override with `BASE=`). Mints a real admin session server-side (Supabase `generateLink` + `verifyOtp`, no password), builds the `@supabase/ssr` cookie, and fetches 19 pages (+1 real project-detail page) as that admin — catching server-component render errors an unauthenticated HTTP probe would miss.
- **Run:** `node scripts/auth-smoke.mjs` (from `web/`); `BASE=http://localhost:3000 node scripts/auth-smoke.mjs` for local.
- **CI:** `.github/workflows/e2e-smoke.yml` — weekly (Mondays 21:00 UTC) + `workflow_dispatch`. Doubles as demo keep-alive against the Supabase free-tier inactivity pause (see memory: `supabase-pause-demo-outage`).

### Other smoke scripts (`web/scripts/`)

| Script | Covers |
|---|---|
| `smoke.mjs` | API smoke test against a running dev server + live DB, using maker/checker PATs from `.env.local`. |
| `smoke-gov.mjs` | Governance hero-path smoke: the full four-eyes loop + audit trail, via PATs. |
| `smoke-body.mjs` | Stronger page rehearsal than `auth-smoke.mjs` — inspects response **bodies**, not just status, since a streamed page can return 200 with an error-boundary payload. |
| `mcp-smoke.mjs` | Smokes the native MCP server (`web/mcp/server.mjs`) over stdio JSON-RPC: initialize → tools/list → a live `list_projects` call. |

### Recent receipts (`sprint-log/`)

These are narrative build receipts, not evidence-tree entries — read them for what shipped and what each wave verified before landing:

- `sprint-log/2026-08-14_test-hardening/SPRINT_SUMMARY.md` — the overnight pre-demo hardening sprint: unit suite 22→36 files/1,019 tests, e2e suite stood up (53 tests, Tier 1 + Tier 2), 4 journey bugs found+fixed (tokens-page revocation display, self-reject 500, notification-email CTA injection, realtime-bell unhandled rejection).
- `sprint-log/2026-08-14_maker-withdraw/SPRINT_SUMMARY.md` — maker-withdraw shipped on deletion requests (R-03 extension), contract surfaces synced, e2e Tier-2 journey extended to cover it, then a pre-demo deploy of everything pending.
- `sprint-log/2026-08-14_devops-wave1a/SPRINT_SUMMARY.md` — project-lock enforcement in triplicate (R-65) + baseline rate limiting (R-66) + companion perf migrations, landed with live DB-transaction verification. See `testing-log/2026-08-14_wave1a-live-verification/` for this testing log's own record of that verification.

## Journey → coverage index

Honest mapping: a product journey to the suite(s) that actually exercise it end to end. `MISSING` means nothing does — not "probably covered somewhere."

| Journey | Unit (vitest) | E2E (Playwright) | Live/smoke | CI wiring | Notes |
|---|---|---|---|---|---|
| Login / demo funnel | — | `public.spec.ts`, `demo-login.spec.ts` (entry-path identity, not just admin) | `auth-smoke.mjs` (page-render only, not the login form itself), `smoke-body.mjs` | `e2e-smoke.yml` weekly | Password-login success path (not just the wrong-credentials error) has no e2e coverage — **MISSING**. |
| Governed task lifecycle (create → status transitions → schedule fields) | `lib/schedule/cpm.test.ts`, `lib/status.test.ts`, `app/api/schemas.test.ts`, `governance/lock.test.ts` + `lock-db-backstop.test.ts` (lock triplicate) | `writes.spec.ts` (Tier 2: create → task → status PATCH), `project-detail.spec.ts` (Board/Gantt render), `console-pages.spec.ts` | `smoke.mjs`, `smoke-gov.mjs` | none dedicated | Kanban drag-as-audited itself (the actual drag gesture, not the underlying PATCH) has no e2e coverage — **MISSING**. |
| Maker-checker delete, incl. withdraw | `lib/governance/deletion-dispatch.test.ts` (per-entity-type commit dispatch — task/project RPC routing, per the devops-wave1b maker-checker-on-projects extension). No dedicated unit file under `src/app/api/deletion-requests/` for the request/approve/reject/withdraw **routes** themselves — that state machine is exercised by e2e + DB CHECK constraints, not vitest, beyond the dispatch layer | `writes.spec.ts` Tier 2 (full loop: request → self-approve blocked → self-reject blocked → withdraw → re-withdraw blocked → re-request → foreign-withdraw blocked → checker rejects) | `smoke-gov.mjs` | none dedicated (Tier 2 is opt-in, not in any workflow) | The only full-loop coverage is Tier-2 e2e, which is **not CI-wired** — it runs only when a human/agent invokes it locally with `E2E_WRITES=1`. `deletion-dispatch.test.ts` is new since wave-1a's 1,063/40 snapshot (a parallel wave1b task landing maker-checker on projects) — count this index's suite numbers as a moving target, not a fixed one. |
| Lock → rebaseline | `governance/lock.test.ts`, `governance/lock-db-backstop.test.ts` | — | live DB-transaction probe, `testing-log/2026-08-14_wave1a-live-verification/` | none | Rebaseline **apply** (the `nopm_apply_rebaseline_snapshot` RPC + bypass carve-out) has DB-backstop unit coverage but **no e2e journey** exercises the full lock→rebaseline→apply UI flow — **MISSING**. |
| PAT mint / revoke | `lib/auth/tokens.test.ts` (hashing/scopes), `lib/auth/scopes.test.ts` (scope registry) | `writes.spec.ts` Tier 2 ("mint and revoke a PAT through the tokens UI") | `mcp-smoke.mjs` (consumes a PAT, doesn't mint one) | none dedicated | — |
| Assistant (BYOK) | `lib/crypto.test.ts` (AES-256-GCM round-trip/tamper/wrong-key), `lib/assistant/scopes.test.ts`, `lib/assistant/token.test.ts` (ephemeral token ceiling), `lib/assistant/tools-openapi.test.ts` (least-privilege drift lock) | — | — | none | Unit coverage is real and specific (crypto + scope ceiling + drift lock); no e2e or live-smoke coverage of an actual assistant conversation turn (fallback or provider path) exists — **MISSING** at the integration/e2e layer. |
| Notifications (bell, My Work) | `lib/notify/email.test.ts` (subject map, CTA construction, XSS regression) | `console-pages.spec.ts` (`/my-work` page renders; no content assertion) | — | none | No `bell.test.*` file exists — the realtime-bell StrictMode double-mount/unmount-race fix (`2026-08-14_test-hardening`) shipped with no regression test pinning it — **MISSING**. |

## Dated entries

- [`2026-08-14_wave1a-live-verification/`](./2026-08-14_wave1a-live-verification/README.md) — live-DB rolled-back transaction probe closing devops-wave-1a (project lock P0010 enforcement, rate-limit RPC countdown, auth-smoke 19/19).
- [`2026-08-20_demo-preflight/`](./2026-08-20_demo-preflight/README.md) — full-battery demo pre-flight: 1,718 unit tests, RTM 67/432, e2e Tier-1 77/77 **against live**, funnel-identity probe (demo = manager), 23-page screenshot + timing pass as the demo identity.
- [`2026-09-07_mobile-ui/`](./2026-09-07_mobile-ui/FINDINGS.md) — mobile audit for R-94: 29 routes × iPhone 14 / small Android, baseline vs after screenshots and measurements (`results.json`, `results-after.json`), `COMPARISON.md` from the single-agent re-audit.
- [`2026-09-07_oss-improvements/`](./2026-09-07_oss-improvements/README.md) — gate battery + per-requirement verifier verdicts for R-88 … R-94 (self-host path, nonce CSP, optimistic concurrency, MFA challenge, contributor governance, use cases/BPDs, mobile console).

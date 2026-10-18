# Sprint: test hardening + journey fixes (pre-founder-demo)

**Date:** 2026-08-14 (overnight, autonomous session)
**Intent:** "sufficient unit + e2e tests for all functions and buttons" + "carefully fix all journeys" ahead of a founder-level demo (CTO + PMO Lead audience).

## What shipped

### Unit tests (vitest): 22 → 36 files, 1,019 tests, all green
New coverage for the previously untested pure logic:
- `lib/schedule/cpm.test.ts` — critical-path forward/backward pass, slack, cycles
- `lib/resource/utilisation.test.ts` — capacity math, zero-capacity, >100% edges
- `lib/status.test.ts`, `lib/cn.test.ts`
- `lib/nav/entity-href.test.ts` (9 entity kinds + FOCUS_PARAM completeness), `lib/nav/recent-projects.test.ts` (MRU, corrupt-JSON)
- `lib/notify/email.test.ts` — subject map, CTA construction, **XSS regression guards**
- `lib/reports/html.test.ts` + `index.test.ts` — section registries, escaping, pptx/pdf magic bytes
- `lib/api/response.test.ts` + `errors.test.ts` — the one-JSON-contract envelope, error→status mapping, sanitized 500
- `lib/ref-id.test.ts` — suffix parse, COUNT+1 fallback quirk pinned
- `lib/clash/detect.test.ts` — overlap sweep incl. a **pinned known false-positive** (see Findings)
- `app/api/schemas.test.ts` — Zod contract tests for tasks/risks/budget/rebaselines/projects/tokens

### E2E suite (Playwright, new): `web/e2e/` — 53 tests
- `@playwright/test` + Chromium added as devDependency; `npm run e2e`; artifacts gitignored.
- Auth: `e2e/global-setup.mjs` mints a real admin session (same generateLink→verifyOtp→cookie technique as `scripts/auth-smoke.mjs`) into a Playwright storage state.
- **Tier 1 (default, read-only):** public pages, login errors, unauth redirects, demo-login funnel (entry-path identity!), all 19 console pages render with their primary actions, sidebar/⌘K palette/account menu/bell/theme/assistant chrome, every "New X" dialog opens+cancels, project detail 8 tabs + kanban columns + gantt views, machine surfaces (health/openapi/llms.txt). **51 passed / 0 failed.**
- **Tier 2 (opt-in `E2E_WRITES=1`):** full governed journey (create → task → status → maker-checker request → self-approve blocked → self-reject 422 → checker rejects → cleanup) + PAT mint/revoke through the UI. **2/2 green.** Leaves audit rows by design — don't run against the live demo right before a pitch.

## Bugs found and fixed (all verified by tests)
1. **Tokens page revocation invisible** — page read `revoked_at` but the API returns boolean `revoked`; revoked PATs displayed "active" forever (`app/(console)/tokens/page.tsx`). R-02 demo surface.
2. **Self-reject 500 (route-vs-DB drift)** — reject route docstring claimed self-rejection allowed, but the `maker_checker_different` CHECK binds all decided rows → raw constraint 500. Route now mirrors the approve guard (422) (`api/deletion-requests/[id]/reject/route.ts`). *Open question for owner:* should makers be able to withdraw their own requests? (would need the CHECK narrowed to approved/committed via migration).
3. **Notification email CTA injection** — `payload.href` interpolated into the CTA `href` unescaped + no same-origin validation (`lib/notify/email.ts`). Now escaped + restricted to absolute paths; non-paths fall back to `/dashboard`.
4. **Realtime bell unhandled rejection** — StrictMode double-mount re-used the already-subscribed `notifications-bell` channel (`.on()` after `subscribe()` throws); also an unmount race leaked zombie subscriptions. Cancellation flag + `removeChannel` cleanup (`components/notifications/bell.tsx`).

## Findings surfaced, deliberately NOT changed
- `detectOverAllocation` over-counts allocations that overlap a wide anchor but not each other (10% year + 60% Jan + 60% Nov → flags 130%; true peak 70%). Conservative direction (false positive, never false negative); pinned in tests; fixing means a sweep-line peak computation — owner's call.
- `reports/index.ts` filename slug unsanitized (quotes/slashes survive); `reports/html.ts` `esc()` handles `&<>` only (safe at current text-node call sites — pinned).
- Budget variance/burn arithmetic still inlined in the route (untestable without extraction) — extraction targets listed in the session's coverage report.

## Ops notes
- **Live site verified healthy** before and during the session: landing/health/demo-login 302→dashboard, auth-smoke 19/19 pages green.
- **The four code fixes are NOT yet deployed** — Vercel deploys are manual. Deploy before the founder demo to get the tokens-page + reject-422 fixes live.
- Demo DB left clean: e2e projects/tasks/tokens removed; bootstrap maker/checker PAT fixtures restored (both had been left revoked, which is why the four-eyes smoke path was broken).
- Knowledge graph built: `graphify-out/graph.html` + `GRAPH_REPORT.md` (721 nodes, 24 communities).

## RTM
Tests map to R-60 (unit + governance-invariant tests); no requirement rows changed. If this work is committed, no RTM edit is required beyond the receipt (this file).

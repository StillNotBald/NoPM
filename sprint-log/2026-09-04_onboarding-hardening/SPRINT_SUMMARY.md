# Sprint Summary — 2026-09-04_onboarding-hardening

**TL;DR:** Researched what ClickUp users actually complain about (`RESEARCH.md`, 14 live Reddit threads + feedback board + review sites), then made NoPM do the opposite: an **Essentials sidebar** (7 modules instead of 22, one click to show all), a data-driven **Getting started** page, one-line **page hints** — plus **HTTP security headers + CSP** (there were none), a **preferences-clobber bug fix**, a **single-fetch preferences store**, and a **project-scoped dependency query**. No migration. Committed locally, **not deployed** — owner runs the deploy.

## Declared goals
- Resolve the onboarding/tutorial gap using ClickUp's failure modes as the anti-pattern list (R-78)
- Improve security (R-79), stability and performance (R-80) without adding features

## Actual outcomes

### Research (input, not code)
`RESEARCH.md` — top-10 ranked complaints with quotes + URLs; "what good onboarding looks like" per users; anti-patterns; a table mapping each complaint to this sprint's change. Headline: sidebar clutter (#3), first-run decision overload (#4), stacked AI promo modals (#6), speed (#2), and "every release breaks something" (#1).

### R-78 — Progressive-disclosure onboarding
- **Essentials nav mode** — `lib/nav/nav-config.ts` (7 essentials: My Work, Tasks, Projects, Dashboard, Risks, Issues, Trust Center), `visibleSections` always keeps the active route visible. Precedence (`lib/nav/nav-mode.ts`): `nopm_nav` cookie → account `nav.mode` → `all` if the account already has a preferences row, else `essentials`. Resolved server-side in `(console)/layout.tsx` before first paint via a React-`cache()`d `readSignedInPreferences()` shared with the root layout (one DB read per request, was two). Toggle at the sidebar foot ("Show all modules · 15 more") and in Settings → **Navigation & help** (also: Reset hints, Show Getting started again).
- **/start** — 5-step checklist from real counts (projects, tasks, active tokens, members) + a client-side "visited" flag for the read-only audit step; role-aware CTAs; 3-tile "how NoPM works"; CLI/curl quickstart verified against `cli/`. Reachable from the sidebar foot, the wizard's last step, the account menu, ⌘K.
- **Page hints** — `lib/onboarding/hints.ts` registry (22 pages, ≤120 chars each, longest-prefix match, project detail distinct from index), mounted once in `app-shell.tsx` under the breadcrumbs. "Learn more" → public GitHub blob URLs of the user manual (the app doesn't serve `user-manual/`). Zero hints on `/dashboard` and `/start`: **at most one onboarding surface per page, never a modal.**
- Manual: `user-manual/operator/00-first-ten-minutes.md` is the new operator "start here".

### R-79 — Security headers + CSP (ADR 0011)
- `lib/security/headers.ts` (pure, tested) → `next.config.ts` `headers()`; `poweredByHeader: false`; `middleware.ts` → `proxy.ts` (Next 16 convention).
- CSP: `default-src 'self'`; `connect-src` self + Supabase REST + `wss` Realtime only; `img-src` self/data/blob/Supabase; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'self'`; `frame-src 'self'`; `worker-src 'self' blob:`; prod-only `upgrade-insecure-requests` + HSTS (1y, no preload); dev-only `'unsafe-eval'`. Plus `nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, deny-by-default `Permissions-Policy`.
- **Review catch:** the worker's first cut used `frame-ancestors 'none'` + `X-Frame-Options: DENY`. Those apply to *every* response, including `/api/documents/:id/file`, which the same-origin PDF viewer iframes — DENY forbids even same-origin framing and would have blanked the preview. Changed to `'self'`/`SAMEORIGIN`; cross-site clickjacking still blocked.
- Accepted step-1 gap: `script-src 'unsafe-inline'` (Next inline RSC payload). Note for the follow-up: the build output shows **every route is already dynamic (ƒ)**, so the ADR's "nonces would de-static the landing page" concern is moot — a nonce-strict CSP via `proxy.ts` is feasible.
- `npm audit fix` (non-forced): cleared `qs` (moderate) and `fast-uri` (high) chains; `pptxgenjs → image-size` remains (documented accepted risk in `docs/SECURITY.md`, parser unreachable).

### R-80 — Stability & perf
- **Bug (real, user-facing):** `PUT /api/me/preferences` replaced the whole config; the wizard and governance tour PUT single keys, so dismissing the tour wiped a real user's saved columns/density/date display. Now a merge-upsert (top-level override, `columns`/`groupBy` per register, size cap on the merged result). OpenAPI + `/llms.txt` updated. 11 regression tests.
- **Perf:** `lib/prefs/store.ts` + `usePreferences()` — one cached GET per session shared by wizard, tour, date-display hook, register prefs hook, sidebar, hints, settings. Browser-verified: **1** `GET /api/me/preferences` per page load (was 3–6, each = auth resolve + demo lookup + rate-limit RPC + row read).
- **Perf:** project detail page fetched every `task_dependencies` row in the workspace; now `successor_id IN (this project's tasks)`, run in parallel with the status-age query (no added round trip), skipped for zero tasks.

## R-IDs touched
- R-78 → DONE (new) · R-79 → DONE (new) · R-80 → DONE (new). RTM: 70 R-IDs, 471 paths verified.

## Files
See the R-78/79/80 rows in `requirements/TRACEABILITY.md`. New ADR: `docs/adr/0011-http-security-headers-and-csp.md`. `docs/SECURITY.md` gains a browser-hardening bullet.

## Tests / verification
| Gate | Result |
|---|---|
| `tsc --noEmit` | clean |
| `eslint src` | clean (1 pre-existing warning in an untouched test) |
| vitest | **1,822 passed** (78 files; baseline 1,718 → +104) |
| `npm run rtm:verify` | OK, 70 R-IDs / 471 paths |
| `npm run build` | green; `/start` compiled; "Proxy (Middleware)" listed, no deprecation warning |
| Playwright Tier 1 vs local prod build (`next start`) | **79 passed, 0 failed**, 12 skipped (write tier + viewer-only, as before) |
| Browser sweep (28 pages, admin session) | headers on every response, **0 CSP violations / console errors**; toggle 22→7 links + cookie; hint dismissal survives reload; 1 prefs GET per page; project detail (Gantt/CPM) renders |

The sweep dismissed one hint and toggled nav on the owner's admin account; those keys were removed from that account's `user_preferences` afterwards (no trace left).

## Process notes
- All build work ran on **AI implementation agents** on disjoint file sets (owner's token-spend rule); the shared foundation (`lib/prefs` store, schema keys) was hand-built first. AI-assisted did review, integration, gates.
- The design hook (`impeccable`) re-flagged the sidebar's pre-existing active-item accent border (`side-tab`). Not introduced here, owner-approved retheme styling; left unchanged and **not suppressed** — owner's call whether to persist an exception.

## Follow-ups
- **Deploy** (owner): `cd web && vercel deploy --prod --yes`, then `node scripts/auth-smoke.mjs` and a quick look at `/documents` (open a PDF) and `/email-previews` to confirm the same-origin iframes under the new headers. No migration to run.
- Nonce-strict CSP via `proxy.ts` (`'nonce-…' 'strict-dynamic'`, drop `'unsafe-inline'` for scripts) — feasible now that all routes are dynamic; add a CSP `report-to` endpoint at the same time.
- Preferences PUT is read-then-write (no OCC); two concurrent PUTs from the same user can still race. Acceptable for display prefs; note if ever reused for governed state.
- `useRegisterPreferences` now returns reactive `columns`/`groupBy` after a local set (previously static); `tasks/page.tsx` is idempotent under that — re-check if another register adopts the hook.
- Mobile bottom nav unchanged (it already has pin/unpin); Essentials mode is desktop-sidebar only.
- Notification noise (ClickUp #5) is already quiet by design; keep "every category switchable" as a guard-rail for any future notification work.
- Owner decision pending: persist or fix the `side-tab` design-hook exception.

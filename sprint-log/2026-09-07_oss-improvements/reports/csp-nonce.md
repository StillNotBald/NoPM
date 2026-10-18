# R-89 — Nonce-based CSP (drop `'unsafe-inline'` from `script-src`)

**Status:** Shipped, verified against a production build and a live demo-login
round trip. Not committed (per file-scope instructions — no git commits).

## What changed

- `web/src/lib/security/headers.ts` — `buildCsp()` now takes a required
  `nonce` and builds `script-src 'self' 'nonce-<n>' https://static.cloudflareinsights.com`
  (no `'unsafe-inline'`). `buildSecurityHeaders()` (still consumed unchanged
  by `next.config.ts`) no longer returns a `Content-Security-Policy` header
  at all — see "Why the CSP moved out of `buildSecurityHeaders`" below.
- `web/src/proxy.ts` — mints a fresh nonce per request
  (`Buffer.from(crypto.randomUUID()).toString("base64")`), builds the CSP via
  `buildCsp()`, sets it directly on the response, and forwards the nonce to
  the app as the `x-nonce` request header. Matcher widened to cover
  `/api/**` too (previously excluded); `/api/**` requests skip the Supabase
  session-refresh branch (unchanged behavior there) but still get the CSP.
- `web/src/lib/security/headers.test.ts` — rewritten: `buildSecurityHeaders`
  tests now assert NO CSP header; `buildCsp` gets its own suite (17 tests
  total, up from 7), including a per-nonce isolation test and an explicit
  "never `'strict-dynamic'`" assertion.
- `docs/adr/0011-http-security-headers-and-csp.md` — appended "Amendment
  2026-09-07: nonce-based script-src" (did not rewrite history); closed the
  old "Nonce-based strict CSP" follow-up.
- No component changes needed: grepped `web/src` for `<script`, `<Script`,
  and `dangerouslySetInnerHTML` — zero matches outside test files (same
  finding as the original ADR). Nothing needed the nonce wired through.
- `page.tsx` / `login/page.tsx` untouched: `app/layout.tsx` already calls
  `await cookies()` unconditionally, which forces the whole tree dynamic.
  `next build` confirms all 69 routes are `ƒ (Dynamic)`, none static — the
  ADR's original "would de-static the landing page" blocker was already
  moot as of the 2026-09-04 sprint.

## Two deliberate deviations from the literal ask — flagged, not silent

1. **No `'strict-dynamic'`.** Shipped `script-src 'self' 'nonce-<n>' https://static.cloudflareinsights.com`,
   not `'self' 'nonce-<n>' 'strict-dynamic'`. Cloudflare injects its Web
   Analytics beacon as a plain `<script src=...>` at the EDGE, after our
   response leaves the origin — there's no way to stamp our nonce on it.
   `'strict-dynamic'`, where browsers support it, makes them ignore
   host-source allow-list entries in `script-src` entirely (only
   nonce/hash-trusted scripts and what they load are trusted), which would
   silently re-block the beacon — reproducing the exact 2026-09-05 live
   regression the current ADR already documents fixing once. Full rationale
   in the ADR amendment, plus the path to add it later (owner disables
   Cloudflare's automatic beacon injection and self-hosts a nonce-carrying
   `<script>` instead).
2. **`style-src` unchanged (`'self' 'unsafe-inline'`)** — this was in scope
   per your instructions ("keep whatever style-src policy exists"), noting
   why: nonces only cover `<style>` elements, not inline `style="..."`
   attributes, and `app/layout.tsx` stamps a real inline `style` attribute
   (font-size) on `<html>` for the appearance system
   (`src/lib/theme/appearance.ts`, `resolveHtmlAttrs`). Removing
   `'unsafe-inline'` from `style-src` would break first-paint font scaling
   and is a separate, larger piece of work (eliminate every inline `style`
   attribute in the app, or move to per-request nonced `<style>` blocks).

## Why `buildCsp` moved out of `buildSecurityHeaders`

`next.config.ts`'s `headers()` runs once at build/dev-server start — it has
no per-request nonce to work with. If `buildSecurityHeaders` (still called
there, file untouched) kept emitting a nonce-less CSP entry alongside
`proxy.ts` setting its own per-request nonce CSP on the same response, every
response `proxy.ts` covers would carry TWO `Content-Security-Policy`
headers. Browsers enforce multiple CSP headers as an intersection, not an
override, which would make "no `unsafe-inline` anywhere" depend on
multi-header CSP semantics instead of being a flat, checkable fact — and
would likely have left `'unsafe-inline'` visible in one of the two headers
during the curl check. Removing the CSP entry from `buildSecurityHeaders`'s
return array was the way to solve this without touching `next.config.ts`
(explicitly out of scope): that file just spreads whatever the array
contains, so it now naturally stops emitting CSP, and `proxy.ts`'s
per-request header is the only one on the wire. Confirmed live: exactly one
`content-security-policy:` line per response on `/`, `/login`, and
`/api/health`.

## Verification (production build, port 3105)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | `src/lib/security/headers.test.ts`: **17/17 passed**. Full suite: 1946/1947 passed, 1 pre-existing failure (`src/lib/governance/lock.test.ts`, `expected_updated_at` field classification) caused by a concurrent teammate's in-progress OCC work touching `web/src/app/api/tasks/_schema.ts` — outside this task's file scope, unrelated to CSP, not introduced by this change. |
| `npm run build` | green. All 69 routes list `ƒ (Dynamic)`; `Proxy (Middleware)` picked up. |
| `curl -sI http://127.0.0.1:3105/` | `content-security-policy: default-src 'self'; script-src 'self' 'nonce-<random>' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: <supabase>; font-src 'self' data:; connect-src 'self' <supabase-https> <supabase-wss> https://cloudflareinsights.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'; frame-src 'self'; upgrade-insecure-requests` — exactly one CSP header, no `unsafe-inline`/`strict-dynamic` in `script-src`. HSTS, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, `Permissions-Policy`, `nosniff` all present. |
| `curl -sI /login` | same shape, different nonce. |
| `curl -sI /api/health` | same shape, different nonce — confirms API routes are covered. |
| `curl -i -X POST /api/auth/demo-login` | `302` to `/dashboard`, session cookie set, CSP header present with a nonce (confirms the API-route branch doesn't disturb the existing session-refresh work happening on subsequent page loads). |
| Headless Playwright (Chromium via `@playwright/test`, already installed) | Navigated `/`, `/login`, `/case-study`, `/dashboard` (unauthenticated) — **0** console messages matching `Content Security Policy` or `Refused to` on any page. Repeated with a real demo-login click-through (`POST /api/auth/demo-login` against the production Supabase project configured in `web/.env.local`, read-only sign-in, no data written) landing on `/dashboard` authenticated — **0** violations there either. |
| Server shutdown | production server (`npm start`, PID 22228) killed after verification; no residual server left running. |

Note on host: the demo-login redirect `Location` header resolves to
`http://localhost:3105/dashboard` (hardcoded `localhost`, not the
request host), so the Playwright browser context had to navigate via
`http://localhost:3105`, not `http://127.0.0.1:3105` — otherwise the
post-redirect session cookie doesn't carry over (different origins) and the
click-through silently bounces back to `/login`. Not a bug introduced here,
just a note for anyone re-running this verification.

## Residual risks

- **Cloudflare beacon stays on a host allow-list, not a nonce.** If
  Cloudflare ever starts injecting additional scripts (not just the one
  analytics beacon) under that same origin, they'd all be trusted. Low risk
  in practice (Cloudflare controls that origin, and it's the same
  already-audited host from the original ADR) but worth knowing it's an
  allow-listed origin, not a hash/nonce-pinned script.
- **No CSP `report-to`/reporting endpoint** — pre-existing gap (tracked in
  the ADR's Follow-ups before this change too), so a real violation in
  production (e.g. a future third-party script someone adds without
  updating the allow-list) fails silently in the browser console with no
  server-side alert. Unrelated to this change, just still open.
- **`x-nonce` request header is per-request but unauthenticated/unsigned** —
  nothing forges it usefully today (nothing reads it except Next's own
  nonce-parsing and would-be `<Script nonce>` usage, and there are none of
  the latter yet), but if a future inline script is added and reads
  `headers().get("x-nonce")` from a Server Component, that trust chain is
  exactly as strong as `proxy.ts` running first on every request — matcher
  correctness matters more now than before.
- **OCC/lock.test.ts failure** noted above is a pre-existing/concurrent
  issue outside this task, not this change's responsibility, but flagging
  so it isn't mistaken for a regression this work introduced.

## Requests for lead

- **RTM text for R-89** (not added — RTM is outside my file scope):
  suggested row — *"R-89 — Nonce-based CSP: `script-src` carries a
  per-request `nonce-<n>` (minted in `proxy.ts`) instead of
  `'unsafe-inline'`; verified via production build + live header/console
  checks. `style-src` still carries `'unsafe-inline'` (inline `style`
  attribute for font-scale, not a `<style>` element — nonces don't cover
  it). No `'strict-dynamic'` — Cloudflare's edge-injected analytics beacon
  can't carry our nonce; see ADR 0011 Amendment 2026-09-07."*
- **Owner call, not mine:** whether disabling Cloudflare's automatic Web
  Analytics beacon injection (Cloudflare dashboard) and self-hosting a
  nonce-carrying `<script>` for it instead is worth doing, to unlock
  `'strict-dynamic'`. Not done here — infra-dashboard change outside this
  codebase and outside "ask first" territory I'd want to cross without you.
- **Not done, explicitly out of scope for this task:** `style-src` nonce
  migration (would need eliminating the `app/layout.tsx` inline `style`
  attribute — a real, if small, refactor), and the CSP `report-to` follow-up
  (needs an owner-approved storage/alerting destination first, per the
  existing ADR).

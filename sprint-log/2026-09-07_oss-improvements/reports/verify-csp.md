# Verify: R-89 nonce-based CSP — adversarial review

Reviewed `csp-nonce.md` + the actual diff (`web/src/proxy.ts`,
`web/src/lib/security/headers.ts`, `web/src/lib/security/headers.test.ts`,
`docs/adr/0011-http-security-headers-and-csp.md`). Verified against a real
production build: `next build`, then the **actual standalone server artifact**
(`node .next/standalone/server.js`, port 3106 — not `next start`, which prints
`"next start" does not work with "output: standalone"` and is not what a real
deploy runs) plus headless Playwright (`@playwright` plugin, isolated
Chromium) for console/DOM checks, and a real demo-login round trip.

## Verdict by item

**1. Exactly one CSP header on every response class — CONFIRMED.**
Checked `/`, `/login`, `/case-study`, `/dashboard` (authed), `/api/health`,
`/api/tasks` (401), a 404 page, and a `/_next/static/chunks/*.js` asset.
Every non-static-asset response carries exactly one
`content-security-policy:` header (`grep -ic` = 1 each); static assets carry
none (matcher exclusion works as claimed). No double-header risk from
`next.config.ts` — confirmed its `headers()` call still runs
`buildSecurityHeaders`, and that function's diff (`web/src/lib/security/headers.ts`)
no longer includes a `Content-Security-Policy` entry in its returned array.

**2. Nonce reaches Next's own inline scripts — CONFIRMED, verified against
the real production artifact, not `next start`.**
`grep`+Playwright on `/`, `/login`, `/case-study`, `/dashboard`: every
`<script>` element that has no `src` (the RSC-payload `self.__next_f.push(...)`
hydration scripts) carries `nonce="<value>"` matching the response's CSP
nonce, exact string match, confirmed with a single request (headers + body
together, not two separate requests). `document.querySelectorAll('script[nonce]').length`
matched total inline+chunk script count on every page tested (12–16
depending on page); the handful of scripts without a `nonce` attribute on
`/dashboard` are same-origin `<script src="/_next/static/...">` tags loaded
by webpack's dynamic import for lazy chunks — these are allowed by the
`'self'` host-source term regardless of nonce, which is correct CSP
semantics, not a gap. Playwright console (`level: warning`, `all: true`) was
**0 messages** on every page tested, unauthenticated and after a real
demo-login click-through to `/dashboard`.

Flagging one thing the report did not mention, checked because it looked
fragile: `web/src/proxy.ts:38-42` (`nextWithNonce()`) sets `x-nonce` on the
forwarded **request** headers but never sets `Content-Security-Policy` on
them — only on the outgoing **response** (`response.headers.set(...)` at
lines 46 and 77). Next's own documented recipe
(`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`)
sets `Content-Security-Policy` on **both** `requestHeaders` (before
`NextResponse.next({request:{headers}})`) and the response. I traced why
this still worked here: this Next.js version's `proxy.ts` compiles straight
into a regular server chunk (`grep -rl x-nonce .next` finds it in
`chunks/[root-of-the-server]__*.js`, not a separate edge-function artifact —
`middleware-manifest.json` is empty, `{"middleware":{},"functions":{}}`),
i.e. no edge/origin network hop exists for this build to desync across. That
explains the clean empirical result here. It does not rule out risk under a
future config that reintroduces an edge-runtime split (an explicit
`export const runtime = "edge"`, or Vercel choosing to run it as a separate
Edge Function for some other reason) — the official recipe sets both for a
reason. **Fix (cheap, no behavior change, matches the documented pattern):**
in `nextWithNonce()`, also do `requestHeaders.set("Content-Security-Policy", csp)`
before `NextResponse.next(...)`. Low priority given the current build
topology, but free insurance — recommend doing it anyway since it's a
one-line diff and removes a "why does this even work" question for the next
reader.

**3. Nonce quality/uniqueness — CONFIRMED, with one precision note.**
Fresh per request: two consecutive `curl -sI /` calls produced two different
nonces; three-way check across `/`, `/login`, `/api/health` also all
distinct. Base64-valued, matches CSP's `nonce-source` grammar. Not reflected
anywhere unescaped outside the CSP header / matching `nonce=` attributes
(grepped `src/` for `x-nonce` consumption — none; nothing echoes it into a
URL, attribute, or script body). Not cached: every HTML response carries
`Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`
(confirmed via curl), so there is no `Cache-Control: public` response
serving a stale nonce to a second visitor. **Precision note on "at least 128
bits"**: `Buffer.from(crypto.randomUUID()).toString('base64')` encodes a
UUIDv4's *string form*; the underlying randomness is a standard UUIDv4's
122 bits (128 total minus 6 fixed version/variant bits), not 128. This is
still cryptographically strong and is literally Next.js's own documented
example nonce implementation — not a defect, just don't report it as
"128-bit" in the RTM/ADR text if precision matters there.

**4. `/api/**` matcher change — CONFIRMED both halves of the claim.**
Read `web/src/proxy.ts:44-48`: `/api` paths return early via `nextWithNonce()`
before the `createServerClient`/`getUser()` block is ever reached — the
session-refresh cost is genuinely skipped, not just claimed. Behavior check:
unauthenticated `curl /api/tasks` → `401` with JSON body
`{"error":"Authentication required","code":"unauthorized"}`, not a redirect
to `/login` — confirms API auth semantics are unchanged. Unauthenticated
`/dashboard` (a page) still returns `200` with client-side auth handling
(pre-existing app behavior, unrelated to this change).

**5. No `'strict-dynamic'`, host allow-list accuracy — CONFIRMED.**
Live CSP from all three servers tested:
`script-src 'self' 'nonce-<n>' https://static.cloudflareinsights.com`
— exact match to the host named in
`docs/adr/0011-http-security-headers-and-csp.md:92` and
`sprint-log/2026-09-04_onboarding-hardening/SPRINT_SUMMARY.md:56`, the
record of the actual 2026-09-05 production incident this is protecting
against. `connect-src` carries `https://cloudflareinsights.com` matching the
same record. No `@vercel/analytics` or `@vercel/speed-insights` in
`package.json`/`src` — nothing else needs a script-src allowance. Fonts:
`app/layout.tsx` uses `next/font/google` (`Inter`, `JetBrains_Mono`), which
self-hosts font files at build time under `/_next/static/media/...` — no
`fonts.googleapis.com`/`fonts.gstatic.com` request ever happens at runtime,
so `font-src 'self' data:` is correct and sufficient (confirmed via the
`Link: rel=preload; as="font"` header pointing at a same-origin path).
`frame-ancestors 'self'` and `frame-src 'self'` both present — same-origin
PDF-viewer/email-preview iframes still permitted, matching the fix from the
prior "frame headers apply to framed responses" incident. `worker-src 'self'
blob:` present. `style-src 'self' 'unsafe-inline'` confirmed unchanged, and
the stated reason (inline `style="font-size:..."` attribute stamped on
`<html>` by `resolveHtmlAttrs()`/`appearance.ts`) was verified live: the
authenticated `/dashboard` page has 15 elements with an inline `style`
attribute and renders correctly with 0 console errors under the current
policy.

**6. Report-only vs enforce — CONFIRMED.**
Header name on the wire is `content-security-policy` (enforcing), never
`content-security-policy-report-only`, on any response checked. No
`report-uri`/`report-to` directive present in the CSP string — matches the
report's stated "pre-existing gap, not addressed here, tracked as a
follow-up" framing; not a dead endpoint because there is no endpoint
configured at all (nothing to be dead).

**7. Test substance, not just structure — CONFIRMED.**
Read `web/src/lib/security/headers.test.ts` in full (128 lines, 17 tests).
Real assertions, not shape-only: `expect(scriptSrc).not.toContain("'unsafe-inline'")`
and `expect(scriptSrc).toContain(\`'nonce-${NONCE}'\`)` together in one test;
a separate test builds CSP twice with two different nonce values and asserts
each output contains its own nonce and not the other's (real isolation
check, not just "a nonce exists somewhere"); an explicit
`expect(scriptSrc).not.toContain("'strict-dynamic'")` with a comment
explaining why. `buildSecurityHeaders`'s own test explicitly asserts
`getHeader(headers, "Content-Security-Policy")` is `undefined` for both prod
and dev — directly enforces the "CSP moved out of this function" claim
rather than trusting the doc comment. Ran the suite: 17/17 pass.

## Other checks run (not in the assigned list, but relevant)

- `npx tsc --noEmit`: clean.
- `npm run build`: green, all 69 routes `ƒ (Dynamic)`, `Proxy (Middleware)`
  compiled — matches the report.
- `src/lib/governance/lock.test.ts`: 15/15 pass as of this review (the
  report's noted pre-existing failure from a concurrent OCC-work teammate
  has since been resolved by that teammate; not this task's concern either
  way).
- Servers started for this review were killed after use; no residual
  process left on port 3106 (`netstat` confirmed clean after `taskkill`).
  Scratch files written during testing (`scratch-*.html/.txt/.json/.log`
  under `web/`) were deleted; `.next/standalone/public` and
  `.next/standalone/.next/static` (copied in only to run the standalone
  server for this test) were removed afterward.

## Fix list

1. **Recommended, not blocking:** `web/src/proxy.ts:38-42` — add
   `requestHeaders.set("Content-Security-Policy", csp);` inside
   `nextWithNonce()`, matching Next's own documented middleware recipe.
   Currently only `x-nonce` is forwarded on the request; CSP is only ever
   set on the response. Works today because this build's `proxy.ts` compiles
   into the same server chunk as the rest of the app (no edge/origin network
   split exists to desync) — confirmed via `middleware-manifest.json` being
   empty and `x-nonce` appearing in a regular `chunks/[root-of-the-server]__*.js`
   file. One-line, zero-risk change; do it so the code doesn't rely on that
   build-topology detail holding forever.
2. **Cosmetic, only if RTM/ADR text calls out bit-strength:** don't describe
   the nonce as "128-bit" — it's a UUIDv4 (122 bits of entropy). Still a
   correct, strong nonce; just a precision nit if anyone later writes that
   number down.

No other findings. Items 1, 3 (aside from the 122-vs-128 note), 4, 5, 6, 7
fully confirmed with evidence above. Item 2 confirmed working end-to-end on
the actual production server artifact, with one non-blocking hardening
recommendation.

# ADR 0011 — HTTP security headers and a Content-Security-Policy

- **Status:** Accepted
- **Date:** 2026-09-04

## Context

`web/next.config.ts` shipped empty — no `headers()` block, no
`poweredByHeader: false`. The app sent **no** security headers of any kind:
no `Content-Security-Policy` (CSP), no `X-Frame-Options`, no
`Strict-Transport-Security` (HSTS), no `Referrer-Policy`, no
`Permissions-Policy`, and the default Next.js `X-Powered-By: Next.js`
response header leaked the framework to any client. For a live-hosted app
handling real auth sessions (Supabase) and a BYOK assistant that streams
model output into the page, this is a meaningful gap: no defense-in-depth
against XSS, clickjacking, or MIME-sniffing, and no HSTS to force HTTPS on
repeat visits.

Separately, Next.js 16 renamed the `middleware.ts` file convention to
`proxy.ts` (function renamed `middleware` → `proxy`); the existing
`web/src/middleware.ts` (Supabase session-refresh on navigation) still used
the old convention.

## Decision

### 1. A pure, unit-tested header builder

`web/src/lib/security/headers.ts` exports `buildSecurityHeaders({ isProd,
supabaseUrl })`, returning the full header array `next.config.ts`'s
`headers()` passes through unchanged. Kept framework-free so it is testable
without booting Next.js (`web/src/lib/security/headers.test.ts`, 7 cases).

### 2. The CSP

Built from directives (joined `; `, no newlines):

```
default-src 'self';
script-src 'self' 'unsafe-inline' [+ 'unsafe-eval' in dev only];
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: <supabase-origin>;
font-src 'self' data:;
connect-src 'self' <supabase-https> <supabase-wss> [+ ws://localhost:* http://localhost:* in dev only];
worker-src 'self' blob:;
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'self';
frame-src 'self';
upgrade-insecure-requests   [prod only]
```

`<supabase-origin>` is derived from `NEXT_PUBLIC_SUPABASE_URL` at request
time (its `https://` origin, plus a `wss://` twin for Realtime); if that env
var is missing or fails to parse as a URL, both fall back to a wildcard
(`https://*.supabase.co` / `wss://*.supabase.co`) rather than silently
omitting Supabase and breaking every authenticated page.

**Why `script-src` carries `'unsafe-inline'`, not a strict nonce policy.**
Next's App Router emits inline RSC-payload `<script>` tags on every
response; a nonce-based strict CSP (`'nonce-<value>' 'strict-dynamic'`) is
the harder-but-correct answer, but it requires a fresh nonce injected via
`proxy.ts` on **every** request, which forces the entire app — including the
static landing and case-study pages — off static rendering (see
`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`,
"Static vs Dynamic Rendering with CSP"). A grep of `web/src` confirms the app
has zero inline `<script>` tags of its own and no `dangerouslySetInnerHTML`,
so `'unsafe-inline'` widens the surface for a *hypothetical* future
injection point rather than covering an existing one. This is a documented
step-1 posture, not the final state — see Follow-ups. `'unsafe-eval'` is
scoped to non-production only, per Next's own guidance (React dev-mode uses
`eval` to reconstruct server-side error stacks in the browser; neither React
nor Next use `eval` in production by default).

**Why `frame-src 'self'`, not `'none'` as originally proposed.** The task
that produced this ADR specified `frame-src 'none'`. Grepping `web/src` for
`<iframe` found two same-origin uses that `'none'` would silently break:
`src/components/documents/document-viewer.tsx` embeds an inline PDF preview
(`<iframe src="/api/documents/:id/file">`), and
`src/app/(console)/email-previews/page.tsx` renders a rendered-email preview
via `<iframe srcDoc={html}>`. Chrome enforces `frame-src` against `srcdoc`
iframes using the embedding document's own origin, so `'none'` blocks both
features outright, not just cross-origin embeds. `'self'` is the tightest
value that keeps both working. `frame-ancestors` (a different directive —
who may embed a given response in a frame) is `'self'`, **not** `'none'`:
the header set is applied to every response, and `/api/documents/:id/file`
is itself a response that the same-origin document viewer must be allowed
to embed. `'none'` forbids even same-origin embedding (as does
`X-Frame-Options: DENY`), which would blank the PDF preview; `'self'` /
`SAMEORIGIN` still block every cross-site clickjacking frame.

**Cloudflare Web Analytics (added after the first production sweep, 2026-09-05).** stillnotbald.com sits behind Cloudflare, which injects `https://static.cloudflareinsights.com/beacon.min.js` into every HTML response at the edge and the beacon reports to `https://cloudflareinsights.com`. Neither exists in a local build, so the first production deploy blocked the beacon (analytics silently stopped). Both are allow-listed by exact origin in `script-src` / `connect-src`.

**Other origins checked and excluded.** The BYOK assistant's provider
clients (`src/lib/assistant/providers/{openai,anthropic,google,openrouter}.ts`)
call OpenAI/Anthropic/Google/OpenRouter's APIs, but only from server-side
code — none of those files (nor their only importer, the provider router)
carry a `"use client"` directive, and the browser only ever talks to the
app's own `/api/assistant` (same-origin SSE). No third-party origin needed
in `connect-src` for the assistant. `img-src`/`connect-src` need only the
Supabase origin; there is no other external asset host (no Google Fonts —
`next/font` self-hosts Inter/JetBrains Mono at build time — no CDN, no
analytics beacon).

### 3. The rest of the header set

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN` (belt-and-braces alongside `frame-ancestors
  'self'` for older browsers that don't honor CSP frame-ancestors; must agree
  with it — see above)
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
  — the app uses none of these; deny by default
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`,
  **production only** (would break `http://localhost` in dev), and
  deliberately **without `preload`** — HSTS preload-list submission is an
  irreversible commitment (removal takes months and requires the domain to
  have shipped valid HTTPS the whole time) that belongs to the owner to make,
  not a default an ADR should reach for.
- `poweredByHeader: false` in `next.config.ts` removes `X-Powered-By:
  Next.js`.

### 4. `middleware.ts` → `proxy.ts`

Renamed per Next.js 16's convention change (`node_modules/next/dist/docs/`
`01-app/01-getting-started/16-proxy.md` and
`01-app/03-api-reference/03-file-conventions/proxy.md`): file moved to
`web/src/proxy.ts`, exported function renamed `middleware` → `proxy`. The
Supabase session-refresh logic and `matcher` config are unchanged. `next
build` confirms the route is picked up as `Proxy (Middleware)` with no
deprecation warning.

## Consequences

- Every response now carries a real CSP and the standard hardening headers;
  verified live via `next start` (production mode) against both a page route
  (`/`) and an API route (`/api/health`) — HSTS present, no `'unsafe-eval'`,
  correct Supabase origin resolved from `NEXT_PUBLIC_SUPABASE_URL`.
- `script-src 'unsafe-inline'` and `style-src 'unsafe-inline'` remain real
  gaps versus a strict CSP — see Follow-ups.
- `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy` (COOP/CORP)
  are **not** set. The app doesn't use `SharedArrayBuffer` or other
  COOP/COEP-gated APIs, and setting `COOP: same-origin` with no
  cross-origin-embed use case has no defensive payoff here beyond what
  `frame-ancestors 'self'` already provides against the class of attack
  (cross-window `window.opener` leakage) COOP targets; deferred rather than
  added speculatively.

## Follow-ups

- **CSP `report-to` / `report-uri`.** No reporting endpoint is configured, so
  CSP violations are silently dropped by the browser today. Add a
  `report-to` directive plus a lightweight same-origin collector once
  there's an owner-approved place to store/alert on the reports (raw
  violation reports can leak page structure; shouldn't be logged
  unreviewed).
- **COOP/CORP**, if a future feature needs cross-origin embedding or a
  `SharedArrayBuffer`-gated API — reconsider then, not preemptively.
- **`'strict-dynamic'` for script-src**, if the owner ever disables
  Cloudflare's automatic Web Analytics beacon injection and self-hosts a
  nonce-carrying `<script>` for it instead — see Amendment below for why it
  is not on today.

## Amendment 2026-09-07: nonce-based script-src

**Status:** Accepted (closes the "Nonce-based strict CSP" follow-up above).

`script-src` no longer carries `'unsafe-inline'`. `web/src/proxy.ts` mints a
fresh per-request nonce (`crypto.randomUUID()`, base64-encoded), builds the
CSP via `buildCsp()` (`web/src/lib/security/headers.ts`) with that nonce, and
sets `Content-Security-Policy` directly on the response it returns; it also
forwards the nonce to the app as the `x-nonce` request header. Next.js parses
the nonce back out of the response header during SSR and auto-attaches it to
every framework-emitted inline `<script>` (RSC payload, runtime chunks) —
per `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`,
"How nonces work in Next.js". The app itself has zero `<script>`/`<Script>`
tags and no `dangerouslySetInnerHTML` (reconfirmed by grep for this
amendment), so no component needed to be touched to read `x-nonce`.

**Why this was blocked, and why it no longer is.** The original ADR text
worried that nonces require dynamic rendering everywhere, which would force
the static marketing landing/case-study pages off static rendering. That
concern was already moot by 2026-09-04 (see that sprint's summary): the root
layout (`app/layout.tsx`) calls `await cookies()` unconditionally to resolve
appearance preferences, which forces every page in the tree — `/`, `/login`,
`/case-study` included — to render dynamically already. `next build` (this
amendment) confirms all 69 routes list as `ƒ (Dynamic)`, none static. No page
needed a `dynamic = "force-dynamic"` export or `connection()` call.

**Why `buildCsp` moved out of `buildSecurityHeaders`.** `next.config.ts`'s
`headers()` function has no access to a per-request nonce — it runs once at
build/dev-server start. Keeping a (necessarily nonce-less) CSP entry there
alongside `proxy.ts`'s per-request nonce CSP would have put two
`Content-Security-Policy` headers on every response `proxy.ts` covers, which
browsers enforce as an intersection rather than an override — the "no
`unsafe-inline`" verification would then depend on browser-specific
multi-header CSP semantics instead of being a plain, checkable fact.
`buildSecurityHeaders` (still called from the untouched `next.config.ts`) now
returns every header EXCEPT the CSP; `buildCsp` is the CSP builder, called
fresh per request from `proxy.ts` only.

**`proxy.ts`'s matcher now covers `/api/**` too.** The verification target
included `/api/health`, and the "no unsafe-inline anywhere" claim should hold
for API responses as much as page responses. The matcher's negative
lookahead was narrowed to exclude only true static assets
(`_next/static`, `_next/image`, `favicon.ico`, image file extensions) —
those never execute a document-level CSP, so skipping them is standard
practice, not a coverage gap. Inside `proxy()`, `/api/**` requests skip the
Supabase session-refresh branch (unchanged scope/behavior from before) but
still get the nonce CSP set directly on the response.

**Deliberately no `'strict-dynamic'`.** The task that produced this
amendment asked for `script-src 'self' 'nonce-<n>' 'strict-dynamic'`.
Shipped instead: `script-src 'self' 'nonce-<n>' https://static.cloudflareinsights.com`
(no `'strict-dynamic'`). Reason: Cloudflare injects its Web Analytics beacon
(`static.cloudflareinsights.com/beacon.min.js`) as a plain `<script src=...>`
tag at the EDGE, after this app's response has already left the origin —
`proxy.ts` has no way to stamp that tag with the per-request nonce. Where
supported, `'strict-dynamic'` makes browsers ignore host-source allow-list
entries in `script-src` entirely (only nonce/hash-trusted scripts, and
scripts they load, are trusted), so adding it would silently re-block the
beacon — reproducing the exact regression the 2026-09-05 live sweep already
fixed once (see the "Cloudflare Web Analytics" section above). Keeping the
beacon's origin as a plain host-source entry, without `'strict-dynamic'`,
still fully removes `'unsafe-inline'` and still requires every inline script
to carry a valid nonce; it just also permits that one already-audited,
already-necessary external origin. If the owner later disables Cloudflare's
automatic beacon injection (Cloudflare dashboard, not this codebase) and
self-hosts a nonce-carrying `<script>` for it instead, `'strict-dynamic'`
becomes safe to add — tracked as a Follow-up.

**`style-src` is unchanged (`'self' 'unsafe-inline'`).** Nonces only cover
`<style>` elements, not inline `style="..."` attributes. `app/layout.tsx`
stamps a real inline `style` attribute (`font-size`, from
`resolveHtmlAttrs()` in `src/lib/theme/appearance.ts`) on `<html>` for the
appearance system's font-scale dial, and that is a `style` ATTRIBUTE, not a
`<style>` element — a nonce cannot cover it. Removing `'unsafe-inline'` from
`style-src` without first eliminating every inline `style` attribute in the
app would break first-paint font scaling. Out of scope for this amendment.

**Verified** (production build, `next start` on port 3105, `web/.env.local`
pointing at the real Supabase project): `tsc --noEmit` clean; `vitest run`
green for `src/lib/security/headers.test.ts` (rewritten: `buildSecurityHeaders`
no longer emits a CSP header at all — new tests assert that directly —
`buildCsp` gets its own per-nonce test suite); `npm run build` green, all 69
routes `ƒ (Dynamic)`. Live header check on `/`, `/login`, and `/api/health`:
exactly one `Content-Security-Policy` header each, a distinct nonce per
request, no `'unsafe-inline'` and no `'strict-dynamic'` in `script-src`, the
Cloudflare beacon origin still present. Headless Playwright pass on `/`,
`/login`, `/case-study`, and `/dashboard` (unauthenticated) plus a real
demo-login round trip (`POST /api/auth/demo-login` against the production
Supabase project, then `/dashboard` authenticated): zero console messages
matching "Content Security Policy" or "Refused to" on any of them.

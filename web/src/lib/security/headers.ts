/**
 * Pure builder for the app-wide HTTP security header set, including the
 * Content-Security-Policy (CSP). `next.config.ts` `headers()` consumes
 * `buildSecurityHeaders` for the static, path-independent header set;
 * `proxy.ts` consumes `buildCsp` directly, once per request, because the CSP
 * carries a fresh nonce that only exists at request time (see below). Kept
 * dependency-free and side-effect-free so both are unit testable without
 * booting Next.js (`web/src/lib/security/headers.test.ts`).
 *
 * CSP posture (Amendment 2026-09-07 — nonce-based script-src, see ADR 0011):
 * - `script-src 'self' 'nonce-<value>' <allow-listed hosts>` — NO
 *   `'unsafe-inline'`. The nonce is generated fresh per request in
 *   `proxy.ts` and forwarded to the app via the `x-nonce` request header;
 *   Next.js parses the nonce back out of the `Content-Security-Policy`
 *   response header during SSR and attaches it automatically to every
 *   framework-emitted inline `<script>` (RSC payload, framework runtime).
 *   `'unsafe-eval'` is still added outside production only, for React
 *   dev-mode's `eval`-based error-stack reconstruction.
 * - Deliberately NOT `'strict-dynamic'`. Cloudflare (stillnotbald.com sits
 *   behind it) injects its Web Analytics beacon
 *   (`https://static.cloudflareinsights.com/beacon.min.js`) as a plain
 *   `<script src=...>` tag at the EDGE, after this app's response has
 *   already left the origin — there is no way for `proxy.ts` to stamp that
 *   tag with our nonce. `'strict-dynamic'`, where supported, makes browsers
 *   ignore host-source allow-list entries for scripts entirely (nonce/hash
 *   sources become the only source of trust), which would silently re-block
 *   the beacon exactly as it did on the first production deploy (see the
 *   `CF_INSIGHTS_SCRIPT` note below and ADR 0011 §"Cloudflare Web
 *   Analytics"). A plain host-source allow-list entry alongside the nonce
 *   keeps the beacon working without reintroducing `'unsafe-inline'`.
 *   Flagged in the sprint report as a follow-up if the owner wants to
 *   disable Cloudflare's automatic beacon injection and self-host it with a
 *   nonce instead — `'strict-dynamic'` becomes safe to add at that point.
 * - `style-src` KEEPS `'unsafe-inline'`. Nonces only cover `<style>`
 *   elements, not inline `style="..."` attributes, and
 *   `resolveHtmlAttrs`/`app/layout.tsx` stamps a real inline `style`
 *   attribute (`font-size`) on `<html>` for the appearance system
 *   (`src/lib/theme/appearance.ts`) — removing `style-src 'unsafe-inline'`
 *   would break first-paint font scaling. Unchanged from the prior policy.
 * - `frame-src 'self'` (not `'none'`): the document viewer embeds a
 *   same-origin PDF preview (`<iframe src="/api/documents/:id/file">` in
 *   `src/components/documents/document-viewer.tsx`) and the email-previews
 *   page renders a `srcDoc` iframe (`src/app/(console)/email-previews/page.tsx`).
 *   Chrome enforces `frame-src` against `srcdoc` iframes using the parent's
 *   origin, so `'none'` would silently break both features; `'self'` is the
 *   tightest value that keeps them working.
 * - `frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN` (not 'none' /
 *   DENY): these headers are applied to EVERY response, including the
 *   framed ones — `/api/documents/:id/file` is itself a response that must
 *   be embeddable by the same-origin document viewer. `'none'`/`DENY` forbid
 *   even same-origin embedding and would blank the PDF preview. `'self'`
 *   still blocks every cross-site clickjacking frame.
 *
 * Why the CSP header is NOT part of `buildSecurityHeaders`'s return value:
 * `next.config.ts`'s `headers()` function is evaluated once (build/dev-server
 * start), with no access to a per-request nonce — it cannot produce a valid
 * nonce CSP. `buildCsp` is called fresh, per request, from `proxy.ts` instead,
 * which sets the header directly on the response it returns. If
 * `buildSecurityHeaders` also emitted a (necessarily nonce-less) CSP,
 * `next.config.ts`'s static header entry and `proxy.ts`'s per-request header
 * would both land on the same response for every path `proxy.ts` covers —
 * two `Content-Security-Policy` headers, which browsers enforce as an
 * intersection (AND, not override) and which would make the "no
 * `'unsafe-inline'`" verification unreliable. `proxy.ts`'s matcher now covers
 * every route except true static assets (`_next/static`, `_next/image`,
 * favicon, image files) — those never execute a document-level CSP, so
 * going without one is standard practice, not a gap.
 */

export interface BuildSecurityHeadersOptions {
  isProd: boolean;
  supabaseUrl?: string;
}

export interface BuildCspOptions extends BuildSecurityHeadersOptions {
  /** Per-request nonce (base64/opaque string, no quoting) — see proxy.ts. */
  nonce: string;
}

export interface SecurityHeader {
  key: string;
  value: string;
}

/** Derive `https://<host>` and its `wss://<host>` twin from a Supabase project URL. */
function deriveSupabaseOrigins(supabaseUrl: string | undefined): { https: string; wss: string } | null {
  if (!supabaseUrl) return null;
  try {
    const url = new URL(supabaseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const https = `${url.protocol}//${url.host}`;
    const wss = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
    return { https, wss };
  } catch {
    return null;
  }
}

// Cloudflare Web Analytics: the edge injects
// https://static.cloudflareinsights.com/beacon.min.js into every HTML
// response on stillnotbald.com and the beacon POSTs to
// https://cloudflareinsights.com/cdn-cgi/rum. Neither appears in a local
// build, which is how the first cut of this policy blocked them in prod
// (browser sweep 2026-09-05). Allow-listed by exact origin. The beacon tag
// carries no nonce (Cloudflare injects it after this app's response leaves
// the origin) — see the file-level doc comment for why script-src therefore
// omits 'strict-dynamic'.
const CF_INSIGHTS_SCRIPT = "https://static.cloudflareinsights.com";
const CF_INSIGHTS_CONNECT = "https://cloudflareinsights.com";

/** Build the app-wide `Content-Security-Policy` header value for one request. */
export function buildCsp(opts: BuildCspOptions): string {
  const { isProd, supabaseUrl, nonce } = opts;
  const supabase = deriveSupabaseOrigins(supabaseUrl);
  const supabaseHttps = supabase?.https ?? "https://*.supabase.co";
  const supabaseWss = supabase?.wss ?? "wss://*.supabase.co";

  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    CF_INSIGHTS_SCRIPT,
    ...(isProd ? [] : ["'unsafe-eval'"]),
  ];
  const connectSrc = [
    "'self'",
    supabaseHttps,
    supabaseWss,
    CF_INSIGHTS_CONNECT,
    ...(isProd ? [] : ["ws://localhost:*", "http://localhost:*"]),
  ];

  const directives: string[] = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${supabaseHttps}`,
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "frame-src 'self'",
    ...(isProd ? ["upgrade-insecure-requests"] : []),
  ];

  return directives.join("; ");
}

/**
 * Build the app-wide security header set MINUS `Content-Security-Policy`
 * (that one is per-request and nonce-bearing — see `buildCsp` and the
 * file-level doc comment). Consumed by `next.config.ts`'s `headers()`.
 */
export function buildSecurityHeaders(opts: BuildSecurityHeadersOptions): SecurityHeader[] {
  const { isProd } = opts;

  const headers: SecurityHeader[] = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "SAMEORIGIN" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    },
  ];

  if (isProd) {
    // No `preload`: that is an irreversible commitment (submission to browser
    // preload lists) the owner has not made.
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains",
    });
  }

  return headers;
}

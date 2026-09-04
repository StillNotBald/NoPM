/**
 * Pure builder for the app-wide HTTP security header set, including the
 * Content-Security-Policy (CSP). Consumed by `next.config.ts` (`headers()`).
 * Kept dependency-free and side-effect-free so it can be unit tested without
 * booting Next.js.
 *
 * CSP posture (step 1, not the final state):
 * - `script-src 'self' 'unsafe-inline'` (plus `'unsafe-eval'` only outside
 *   production, for React's dev-mode error-stack reconstruction — see
 *   node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md).
 *   Next's App Router emits inline RSC-payload `<script>` tags on every
 *   response, so a plain `'self'` script-src would break every page. A
 *   nonce-based strict CSP (`'nonce-<value>' 'strict-dynamic'`) removes the
 *   need for `'unsafe-inline'`, but requires every page to be dynamically
 *   rendered so a fresh nonce can be injected per request (via `proxy.ts`) —
 *   that would force the marketing landing/case-study pages off static
 *   rendering. The app has zero inline `<script>` tags of its own and no
 *   `dangerouslySetInnerHTML` (grepped `src/` to confirm), so `'unsafe-inline'`
 *   only widens the surface for a *hypothetical* future injection, not an
 *   existing one. Tracked as a follow-up in ADR 0011.
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
 */

export interface BuildSecurityHeadersOptions {
  isProd: boolean;
  supabaseUrl?: string;
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

/** Build the app-wide `Content-Security-Policy` header value. */
export function buildCsp(opts: BuildSecurityHeadersOptions): string {
  const { isProd, supabaseUrl } = opts;
  const supabase = deriveSupabaseOrigins(supabaseUrl);
  const supabaseHttps = supabase?.https ?? "https://*.supabase.co";
  const supabaseWss = supabase?.wss ?? "wss://*.supabase.co";

  const scriptSrc = ["'self'", "'unsafe-inline'", ...(isProd ? [] : ["'unsafe-eval'"])];
  const connectSrc = [
    "'self'",
    supabaseHttps,
    supabaseWss,
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

/** Build the full app-wide security header set (CSP + the rest). */
export function buildSecurityHeaders(opts: BuildSecurityHeadersOptions): SecurityHeader[] {
  const { isProd } = opts;

  const headers: SecurityHeader[] = [
    { key: "Content-Security-Policy", value: buildCsp(opts) },
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

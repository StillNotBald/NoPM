import { describe, expect, it } from "vitest";
import { buildCsp, buildSecurityHeaders } from "./headers";

const SUPABASE_URL = "https://abcdefghijkl.supabase.co";
const NONCE = "dGVzdC1ub25jZS12YWx1ZQ==";

function getHeader(headers: { key: string; value: string }[], key: string) {
  return headers.find((h) => h.key === key)?.value;
}

describe("buildSecurityHeaders (path-independent headers — no CSP; see buildCsp)", () => {
  it("prod: includes HSTS", () => {
    const headers = buildSecurityHeaders({ isProd: true, supabaseUrl: SUPABASE_URL });
    expect(getHeader(headers, "Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(getHeader(headers, "Strict-Transport-Security")).not.toMatch(/preload/);
  });

  it("dev: no HSTS", () => {
    const headers = buildSecurityHeaders({ isProd: false, supabaseUrl: SUPABASE_URL });
    expect(getHeader(headers, "Strict-Transport-Security")).toBeUndefined();
  });

  it("never includes a Content-Security-Policy header (that is buildCsp's job, per-request)", () => {
    for (const isProd of [true, false]) {
      const headers = buildSecurityHeaders({ isProd, supabaseUrl: SUPABASE_URL });
      expect(getHeader(headers, "Content-Security-Policy")).toBeUndefined();
    }
  });

  it("sets the rest of the standard hardening headers", () => {
    const headers = buildSecurityHeaders({ isProd: true, supabaseUrl: SUPABASE_URL });
    expect(getHeader(headers, "X-Content-Type-Options")).toBe("nosniff");
    expect(getHeader(headers, "X-Frame-Options")).toBe("SAMEORIGIN");
    expect(getHeader(headers, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(getHeader(headers, "Permissions-Policy")).toContain("camera=()");
  });

  it("no header value contains a newline", () => {
    for (const isProd of [true, false]) {
      const headers = buildSecurityHeaders({ isProd, supabaseUrl: SUPABASE_URL });
      for (const header of headers) {
        expect(header.value).not.toMatch(/[\r\n]/);
      }
    }
  });

  it("every header key is unique", () => {
    for (const isProd of [true, false]) {
      const headers = buildSecurityHeaders({ isProd, supabaseUrl: SUPABASE_URL });
      const keys = headers.map((h) => h.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("buildCsp (per-request, nonce-bearing)", () => {
  it("prod: includes upgrade-insecure-requests and no unsafe-eval", () => {
    const csp = buildCsp({ isProd: true, supabaseUrl: SUPABASE_URL, nonce: NONCE });
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("dev: includes unsafe-eval and localhost ws/http, no upgrade-insecure-requests", () => {
    const csp = buildCsp({ isProd: false, supabaseUrl: SUPABASE_URL, nonce: NONCE });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("ws://localhost:*");
    expect(csp).toContain("http://localhost:*");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("script-src carries the nonce and never 'unsafe-inline' or 'strict-dynamic'", () => {
    for (const isProd of [true, false]) {
      const csp = buildCsp({ isProd, supabaseUrl: SUPABASE_URL, nonce: NONCE });
      const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"))!;
      expect(scriptSrc).toContain(`'nonce-${NONCE}'`);
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      // Deliberately no 'strict-dynamic': the Cloudflare Web Analytics beacon
      // is injected at the edge with no nonce, and 'strict-dynamic' would
      // make browsers ignore the host-source allow-list that keeps it alive.
      expect(scriptSrc).not.toContain("'strict-dynamic'");
    }
  });

  it("a different nonce per call produces a different script-src (no reuse)", () => {
    const a = buildCsp({ isProd: true, supabaseUrl: SUPABASE_URL, nonce: "aaaa" });
    const b = buildCsp({ isProd: true, supabaseUrl: SUPABASE_URL, nonce: "bbbb" });
    expect(a).toContain("'nonce-aaaa'");
    expect(b).toContain("'nonce-bbbb'");
    expect(a).not.toContain("'nonce-bbbb'");
  });

  it("style-src keeps 'unsafe-inline' (nonces don't cover inline style attributes; layout.tsx stamps one)", () => {
    const csp = buildCsp({ isProd: true, supabaseUrl: SUPABASE_URL, nonce: NONCE });
    const styleSrc = csp.split("; ").find((d) => d.startsWith("style-src"))!;
    expect(styleSrc).toBe("style-src 'self' 'unsafe-inline'");
  });

  it("allow-lists the Cloudflare Web Analytics beacon (script) and its RUM endpoint (connect)", () => {
    const csp = buildCsp({ isProd: true, supabaseUrl: SUPABASE_URL, nonce: NONCE });
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"))!;
    expect(scriptSrc).toContain("https://static.cloudflareinsights.com");
    expect(connectSrc).toContain("https://cloudflareinsights.com");
    // exact origins only — no wildcard that would admit other Cloudflare hosts
    expect(csp).not.toContain("*.cloudflareinsights.com");
  });

  it("includes the supabase origin and its wss twin in connect-src (and img-src origin)", () => {
    const csp = buildCsp({ isProd: true, supabaseUrl: SUPABASE_URL, nonce: NONCE });
    const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"))!;
    const imgSrc = csp.split("; ").find((d) => d.startsWith("img-src"))!;

    expect(connectSrc).toContain("https://abcdefghijkl.supabase.co");
    expect(connectSrc).toContain("wss://abcdefghijkl.supabase.co");
    expect(imgSrc).toContain("https://abcdefghijkl.supabase.co");
  });

  it("falls back to a wildcard supabase origin when the url is missing or unparseable", () => {
    const missing = buildCsp({ isProd: true, supabaseUrl: undefined, nonce: NONCE });
    const bad = buildCsp({ isProd: true, supabaseUrl: "not-a-url", nonce: NONCE });

    for (const csp of [missing, bad]) {
      expect(csp).toContain("https://*.supabase.co");
      expect(csp).toContain("wss://*.supabase.co");
    }
  });

  it("always sets frame-ancestors 'self' (same-origin PDF/email iframes must keep working) and object-src 'none'", () => {
    for (const isProd of [true, false]) {
      const csp = buildCsp({ isProd, supabaseUrl: SUPABASE_URL, nonce: NONCE });
      expect(csp).toContain("frame-ancestors 'self'");
      expect(csp).not.toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
    }
  });

  // X-Frame-Options must agree with frame-ancestors — DENY would block the
  // same-origin /api/documents/:id/file iframe that frame-ancestors 'self'
  // allows. Covered here since it's a buildSecurityHeaders concern.
  it("X-Frame-Options is SAMEORIGIN, agreeing with buildCsp's frame-ancestors 'self'", () => {
    for (const isProd of [true, false]) {
      expect(getHeader(buildSecurityHeaders({ isProd, supabaseUrl: SUPABASE_URL }), "X-Frame-Options")).toBe(
        "SAMEORIGIN",
      );
    }
  });

  it("no newline in the CSP value, regardless of nonce content assumptions", () => {
    for (const isProd of [true, false]) {
      const csp = buildCsp({ isProd, supabaseUrl: SUPABASE_URL, nonce: NONCE });
      expect(csp).not.toMatch(/[\r\n]/);
    }
  });
});

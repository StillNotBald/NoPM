import { describe, expect, it } from "vitest";
import { buildSecurityHeaders } from "./headers";

const SUPABASE_URL = "https://abcdefghijkl.supabase.co";

function getHeader(headers: { key: string; value: string }[], key: string) {
  return headers.find((h) => h.key === key)?.value;
}

describe("buildSecurityHeaders", () => {
  it("prod: includes HSTS, upgrade-insecure-requests, and no unsafe-eval", () => {
    const headers = buildSecurityHeaders({ isProd: true, supabaseUrl: SUPABASE_URL });
    const hsts = getHeader(headers, "Strict-Transport-Security");
    const csp = getHeader(headers, "Content-Security-Policy");

    expect(hsts).toBe("max-age=31536000; includeSubDomains");
    expect(hsts).not.toMatch(/preload/);
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("dev: includes unsafe-eval and localhost ws/http, no HSTS", () => {
    const headers = buildSecurityHeaders({ isProd: false, supabaseUrl: SUPABASE_URL });
    const csp = getHeader(headers, "Content-Security-Policy");

    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("ws://localhost:*");
    expect(csp).toContain("http://localhost:*");
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(getHeader(headers, "Strict-Transport-Security")).toBeUndefined();
  });

  it("includes the supabase origin and its wss twin in connect-src (and img-src origin)", () => {
    const headers = buildSecurityHeaders({ isProd: true, supabaseUrl: SUPABASE_URL });
    const csp = getHeader(headers, "Content-Security-Policy")!;
    const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"))!;
    const imgSrc = csp.split("; ").find((d) => d.startsWith("img-src"))!;

    expect(connectSrc).toContain("https://abcdefghijkl.supabase.co");
    expect(connectSrc).toContain("wss://abcdefghijkl.supabase.co");
    expect(imgSrc).toContain("https://abcdefghijkl.supabase.co");
  });

  it("falls back to a wildcard supabase origin when the url is missing or unparseable", () => {
    const missing = buildSecurityHeaders({ isProd: true, supabaseUrl: undefined });
    const bad = buildSecurityHeaders({ isProd: true, supabaseUrl: "not-a-url" });

    for (const headers of [missing, bad]) {
      const csp = getHeader(headers, "Content-Security-Policy")!;
      expect(csp).toContain("https://*.supabase.co");
      expect(csp).toContain("wss://*.supabase.co");
    }
  });

  it("always sets frame-ancestors 'self' (same-origin PDF/email iframes must keep working) and object-src 'none'", () => {
    for (const isProd of [true, false]) {
      const headers = buildSecurityHeaders({ isProd, supabaseUrl: SUPABASE_URL });
      const csp = getHeader(headers, "Content-Security-Policy")!;
      expect(csp).toContain("frame-ancestors 'self'");
      expect(csp).not.toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      // X-Frame-Options must agree: DENY would block the same-origin
      // /api/documents/:id/file iframe that frame-ancestors 'self' allows.
      expect(getHeader(headers, "X-Frame-Options")).toBe("SAMEORIGIN");
    }
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

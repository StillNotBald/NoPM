import { describe, it, expect } from "vitest";
import { resolveInternalOrigin } from "./internal-origin";

const req = (url = "http://evil.example/api/mcp") => new Request(url);

describe("resolveInternalOrigin", () => {
  it("prefers the configured app URL over the Host-derived origin", () => {
    expect(
      resolveInternalOrigin(req(), { NEXT_PUBLIC_APP_URL: "https://nopm.example.com/", NODE_ENV: "production" }),
    ).toBe("https://nopm.example.com");
  });

  it("keeps a configured port and strips any path", () => {
    expect(resolveInternalOrigin(req(), { NEXT_PUBLIC_APP_URL: "http://localhost:3000/app", NODE_ENV: "production" })).toBe(
      "http://localhost:3000",
    );
  });

  it("refuses (null) in production off Vercel when no app URL is configured", () => {
    expect(resolveInternalOrigin(req(), { NODE_ENV: "production" })).toBeNull();
    expect(resolveInternalOrigin(req(), { NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "   " })).toBeNull();
  });

  it("treats a malformed or non-http app URL as unset", () => {
    expect(resolveInternalOrigin(req(), { NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "not a url" })).toBeNull();
    expect(resolveInternalOrigin(req(), { NODE_ENV: "production", NEXT_PUBLIC_APP_URL: "javascript:alert(1)" })).toBeNull();
  });

  it("falls back to the request origin on Vercel (platform-validated Host)", () => {
    expect(resolveInternalOrigin(req("https://nopm.vercel.app/api/mcp"), { NODE_ENV: "production", VERCEL: "1" })).toBe(
      "https://nopm.vercel.app",
    );
  });

  it("falls back to the request origin outside production", () => {
    expect(resolveInternalOrigin(req("http://localhost:3000/api/mcp"), { NODE_ENV: "development" })).toBe(
      "http://localhost:3000",
    );
    expect(resolveInternalOrigin(req("http://localhost:3000/api/mcp"), {})).toBe("http://localhost:3000");
  });
});

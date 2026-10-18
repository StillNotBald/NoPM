/**
 * assertSameOrigin — session mutations must come from the app itself (V1: a
 * `text/plain` PATCH /api/me with a foreign Origin used to return 200).
 */
import { describe, it, expect } from "vitest";
import { assertSameOrigin } from "./origin";
import { ScopeError } from "@/lib/api/errors";

function req(method: string, headers: Record<string, string> = {}, url = "https://app.example.com/api/me") {
  return new Request(url, { method, headers });
}

function refused(r: Request, env: Record<string, string | undefined> = {}) {
  try {
    assertSameOrigin(r, env);
  } catch (e) {
    expect(e).toBeInstanceOf(ScopeError);
    expect([(e as ScopeError).status, (e as ScopeError).code]).toEqual([403, "bad_origin"]);
    return true;
  }
  return false;
}

describe("assertSameOrigin — refuses a foreign Origin on a mutating request", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "patch"])("%s with another site's Origin -> 403 bad_origin", (method) => {
    expect(refused(req(method, { origin: "https://evil.example.net" }))).toBe(true);
  });

  it("an unparseable Origin and the literal 'null' (sandboxed frame) never match", () => {
    expect(refused(req("POST", { origin: "null" }))).toBe(true);
    expect(refused(req("POST", { origin: "not a url at all" }))).toBe(true);
    expect(refused(req("POST", { origin: "" }))).toBe(true);
  });

  it("lookalike hosts do not match (suffix, prefix, other port)", () => {
    expect(refused(req("POST", { origin: "https://app.example.com.evil.net" }))).toBe(true);
    expect(refused(req("POST", { origin: "https://app.example.com:8443" }))).toBe(true);
    expect(refused(req("POST", { origin: "https://xapp.example.com" }))).toBe(true);
  });
});

describe("assertSameOrigin — accepts the app's own origin", () => {
  it("the request's own host (URL and Host header)", () => {
    expect(refused(req("POST", { origin: "https://app.example.com" }))).toBe(false);
    expect(refused(req("POST", { origin: "https://APP.example.com" }))).toBe(false);
    expect(refused(req("POST", { origin: "http://localhost:3000", host: "localhost:3000" }, "http://127.0.0.1:3000/api/me"))).toBe(false);
  });

  it("the public host a proxy forwards, even when the runtime parsed an internal URL", () => {
    const r = req("POST", { origin: "https://app.example.com", "x-forwarded-host": "app.example.com, internal" }, "http://localhost:3000/api/me");
    expect(refused(r)).toBe(false);
  });

  it("the host of NEXT_PUBLIC_APP_URL", () => {
    const r = req("POST", { origin: "https://www.example.org" }, "http://localhost:3000/api/me");
    expect(refused(r)).toBe(true);
    expect(refused(r, { NEXT_PUBLIC_APP_URL: "https://www.example.org" })).toBe(false);
    expect(refused(r, { NEXT_PUBLIC_APP_URL: "not a url" })).toBe(true);
  });

  it("ignores the default port in the Origin", () => {
    expect(refused(req("POST", { origin: "https://app.example.com:443" }))).toBe(false);
  });
});

describe("assertSameOrigin — what it leaves alone", () => {
  it("no Origin header (curl, scripts, server-side callers)", () => {
    expect(refused(req("POST"))).toBe(false);
    expect(refused(req("DELETE"))).toBe(false);
  });

  it("safe methods, whatever the Origin", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(refused(req(method, { origin: "https://evil.example.net" }))).toBe(false);
    }
  });
});

/**
 * clientIp — which address the pre-auth IP rate limits key on (R1 E1.4).
 *
 * The attack: both limiters keyed on the FIRST `x-forwarded-for` entry, which
 * the caller writes, so a fresh value per request meant a fresh bucket. These
 * tests pin the rule that fixes it: a caller-chosen header can never choose the
 * bucket.
 */
import { describe, it, expect } from "vitest";
import { clientIp, ipRateKey, trustedProxyHops } from "./client-ip";

const h = (init: Record<string, string>) => new Headers(init);
const VERCEL = { VERCEL: "1" };

describe("on Vercel — the platform sets the address", () => {
  it("prefers x-vercel-forwarded-for", () => {
    expect(clientIp(h({ "x-vercel-forwarded-for": "198.51.100.9", "x-real-ip": "203.0.113.1", "x-forwarded-for": "6.6.6.6" }), VERCEL)).toBe("198.51.100.9");
  });

  it("falls back to x-real-ip, then to the LAST x-forwarded-for entry", () => {
    expect(clientIp(h({ "x-real-ip": "203.0.113.1", "x-forwarded-for": "6.6.6.6" }), VERCEL)).toBe("203.0.113.1");
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 198.51.100.9" }), VERCEL)).toBe("198.51.100.9");
  });

  it("never takes the client-written first x-forwarded-for entry", () => {
    // Rotating the first value must not change the address.
    const a = clientIp(h({ "x-forwarded-for": "1.1.1.1, 198.51.100.9" }), VERCEL);
    const b = clientIp(h({ "x-forwarded-for": "2.2.2.2, 198.51.100.9" }), VERCEL);
    expect(a).toBe("198.51.100.9");
    expect(b).toBe(a);
  });

  it("returns null when there is no usable header", () => {
    expect(clientIp(h({}), VERCEL)).toBeNull();
  });
});

describe("off Vercel — nothing is trusted unless NOPM_TRUSTED_PROXY_HOPS says so", () => {
  it("returns null by default, however many forwarding headers the caller sends", () => {
    expect(clientIp(h({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "1.2.3.4", "x-vercel-forwarded-for": "1.2.3.4" }), {})).toBeNull();
  });

  it("does not honour x-vercel-forwarded-for from a non-Vercel caller", () => {
    expect(clientIp(h({ "x-vercel-forwarded-for": "198.51.100.9" }), {})).toBeNull();
    expect(clientIp(h({ "x-vercel-forwarded-for": "198.51.100.9" }), { VERCEL: "0" })).toBeNull();
  });

  it("one trusted proxy: the rightmost entry, ignoring whatever the client prepended", () => {
    const env = { NOPM_TRUSTED_PROXY_HOPS: "1" };
    expect(clientIp(h({ "x-forwarded-for": "198.51.100.9" }), env)).toBe("198.51.100.9");
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 198.51.100.9" }), env)).toBe("198.51.100.9");
    expect(clientIp(h({ "x-forwarded-for": "7.7.7.7, 8.8.8.8, 198.51.100.9" }), env)).toBe("198.51.100.9");
  });

  it("two trusted proxies: the second entry from the right", () => {
    const env = { NOPM_TRUSTED_PROXY_HOPS: "2" };
    // client -> CDN (appends client) -> LB (appends CDN) -> app
    expect(clientIp(h({ "x-forwarded-for": "198.51.100.9, 10.0.0.5" }), env)).toBe("198.51.100.9");
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 198.51.100.9, 10.0.0.5" }), env)).toBe("198.51.100.9");
  });

  it("fewer entries than trusted hops means the request skipped the proxies: distrust it", () => {
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6" }), { NOPM_TRUSTED_PROXY_HOPS: "2" })).toBeNull();
    expect(clientIp(h({}), { NOPM_TRUSTED_PROXY_HOPS: "1" })).toBeNull();
  });

  it("rotating the spoofable leading entries never changes the address", () => {
    const env = { NOPM_TRUSTED_PROXY_HOPS: "1" };
    const seen = new Set(
      ["1.1.1.1", "2.2.2.2", "3.3.3.3, 4.4.4.4", "not an ip"].map((spoof) =>
        clientIp(h({ "x-forwarded-for": `${spoof}, 198.51.100.9` }), env),
      ),
    );
    expect([...seen]).toEqual(["198.51.100.9"]);
  });
});

describe("the result is always a valid IP", () => {
  it.each([
    "not-an-ip",
    "999.1.1.1",
    "1.2.3.4:8080",
    "<script>alert(1)</script>",
    "1.2.3.4; drop table x",
    "",
    "a".repeat(5000),
  ])("rejects %j", (junk) => {
    expect(clientIp(h({ "x-real-ip": junk }), VERCEL)).toBeNull();
    expect(clientIp(h({ "x-forwarded-for": junk }), { NOPM_TRUSTED_PROXY_HOPS: "1" })).toBeNull();
  });

  it("accepts IPv6, lower-cased", () => {
    expect(clientIp(h({ "x-real-ip": "2001:DB8::1" }), VERCEL)).toBe("2001:db8::1");
  });

  it("unwraps an IPv4-mapped IPv6 address so both spellings share a bucket", () => {
    expect(clientIp(h({ "x-real-ip": "::ffff:198.51.100.9" }), VERCEL)).toBe("198.51.100.9");
  });
});

describe("trustedProxyHops", () => {
  it.each([
    [undefined, 0],
    ["", 0],
    ["0", 0],
    ["1", 1],
    [" 2 ", 2],
    ["-1", 0],
    ["abc", 0],
    ["1.5", 1],
    ["99", 8],
  ])("%j -> %i", (raw, expected) => {
    expect(trustedProxyHops(raw as string | undefined)).toBe(expected);
  });
});

describe("ipRateKey — what a limiter should key on", () => {
  it("is the plain address for IPv4", () => {
    expect(ipRateKey(h({ "x-real-ip": "198.51.100.9" }), VERCEL)).toBe("198.51.100.9");
  });

  it("collapses IPv6 to its /64, so rotating inside one network cannot mint buckets (or counter rows)", () => {
    const keys = new Set(
      ["2001:db8:1:2::1", "2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:DB8:1:2:0:0:0:ffff", "2001:db8:1:2::"].map((ip) =>
        ipRateKey(h({ "x-real-ip": ip }), VERCEL),
      ),
    );
    expect([...keys]).toEqual(["2001:db8:1:2::/64"]);
  });

  it("keeps different /64 networks apart", () => {
    expect(ipRateKey(h({ "x-real-ip": "2001:db8:1:2::1" }), VERCEL)).not.toBe(
      ipRateKey(h({ "x-real-ip": "2001:db8:1:3::1" }), VERCEL),
    );
  });

  it.each([
    ["::1", "0:0:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["2001:db8::", "2001:db8:0:0::/64"],
    ["64:ff9b::198.51.100.9", "64:ff9b:0:0::/64"],
  ])("normalises %s", (ip, expected) => {
    expect(ipRateKey(h({ "x-real-ip": ip }), VERCEL)).toBe(expected);
  });

  it("is null when no address can be trusted, and honours the same trust rule as clientIp", () => {
    expect(ipRateKey(h({ "x-forwarded-for": "1.2.3.4" }), {})).toBeNull();
    expect(ipRateKey(h({ "x-forwarded-for": "1.2.3.4, 2001:db8:9:9::5" }), { NOPM_TRUSTED_PROXY_HOPS: "1" })).toBe(
      "2001:db8:9:9::/64",
    );
  });
});

describe("rate-limit.ts re-exports", () => {
  it("exposes trustedClientIp and ipRateKey next to checkRateLimit", async () => {
    const mod = await import("./rate-limit");
    expect(mod.trustedClientIp).toBe(clientIp);
    expect(mod.ipRateKey).toBe(ipRateKey);
  });
});

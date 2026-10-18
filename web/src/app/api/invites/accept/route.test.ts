/**
 * POST /api/invites/accept — the IP-keyed abuse guard cannot be steered by the
 * caller's own X-Forwarded-For (R1 E1.4).
 *
 * The route mints Supabase auth users from an unauthenticated request, so it
 * rate-limits per client IP. The cap used to key on the FIRST x-forwarded-for
 * entry, which the caller writes: a new value per request meant a new bucket.
 * The cap is exhausted here on purpose (the RPC always answers "not allowed"),
 * so the 429 is the only thing the route does and the recorded key is the
 * observable under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";

const { calls } = vi.hoisted(() => ({ calls: [] as { fn: string; key: string }[] }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: { p_key: string }) => {
      calls.push({ fn, key: args.p_key });
      return { data: { allowed: false, remaining: 0, retry_after_seconds: 7 }, error: null };
    },
  }),
}));

import { POST } from "./route";

const tokenKey = (token: string) => `invite-accept:tok:${createHash("sha256").update(token).digest("hex")}`;

function accept(headers: Record<string, string> = {}, token = "npi_x") {
  return POST(
    new NextRequest("http://localhost/api/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ token, password: "a-long-enough-password", display_name: "New Member" }),
    }),
    { params: Promise.resolve({}) },
  );
}

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("invites/accept rate-limit key", () => {
  it("429s once the cap is spent, before touching the invite", async () => {
    const res = await accept({ "x-forwarded-for": "198.51.100.9" });
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("rate_limited");
  });

  it("off Vercel with no trusted proxy: keys on the invite token, whatever x-forwarded-for says", async () => {
    for (const spoof of ["1.1.1.1", "2.2.2.2", "3.3.3.3, 4.4.4.4"]) await accept({ "x-forwarded-for": spoof });
    expect(new Set(calls.map((c) => c.key))).toEqual(new Set([tokenKey("npi_x")]));
    expect(calls.every((c) => c.fn === "nopm_rate_check")).toBe(true);
  });

  it("with no trusted address, a flood on one token does not share a bucket with another token", async () => {
    await accept({}, "npi_flooded");
    await accept({}, "npi_flooded");
    await accept({}, "npi_someone_else");
    const keys = calls.map((c) => c.key);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys.every((k) => k !== "invite-accept:unknown")).toBe(true);
    // the raw token never reaches the key
    expect(keys.join()).not.toContain("npi_flooded");
  });

  it("with no trusted address and no usable token, refuses as a validation error without any counter or database work", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/invites/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "a-long-enough-password" }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it("behind one trusted proxy: keys on the address the proxy appended, so a rotating spoofed prefix gains nothing", async () => {
    vi.stubEnv("NOPM_TRUSTED_PROXY_HOPS", "1");
    for (const spoof of ["1.1.1.1", "2.2.2.2", "3.3.3.3, 4.4.4.4"]) {
      await accept({ "x-forwarded-for": `${spoof}, 198.51.100.9` });
    }
    expect(new Set(calls.map((c) => c.key))).toEqual(new Set(["invite-accept:198.51.100.9"]));
  });

  it("an IPv6 caller is keyed on its /64: rotating addresses inside one network gains nothing", async () => {
    vi.stubEnv("VERCEL", "1");
    for (const ip of ["2001:db8:1:2::1", "2001:db8:1:2:dead:beef:0:1", "2001:db8:1:2:ffff:ffff:ffff:ffff"]) {
      await accept({ "x-vercel-forwarded-for": ip });
    }
    expect(new Set(calls.map((c) => c.key))).toEqual(new Set(["invite-accept:2001:db8:1:2::/64"]));
  });

  it("on Vercel: keys on the platform-set address and ignores x-forwarded-for", async () => {
    vi.stubEnv("VERCEL", "1");
    await accept({ "x-vercel-forwarded-for": "198.51.100.9", "x-forwarded-for": "6.6.6.6" });
    await accept({ "x-vercel-forwarded-for": "198.51.100.9", "x-forwarded-for": "7.7.7.7" });
    expect(calls.map((c) => c.key)).toEqual(["invite-accept:198.51.100.9", "invite-accept:198.51.100.9"]);
  });

  it("never lets a junk header become part of the key", async () => {
    vi.stubEnv("VERCEL", "1");
    await accept({ "x-real-ip": "x".repeat(500) });
    expect(calls[0].key).toBe(tokenKey("npi_x"));
  });
});

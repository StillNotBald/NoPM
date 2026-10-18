import { describe, it, expect } from "vitest";
import { resolveTokenExpiry, tokenDaysLeft, tokenExpiresSoon } from "./token-life";
import { assertCanRevokeCreatedBy } from "@/lib/governance/invite-guard";
import { logDeadTokenUse } from "./guard";

const now = new Date("2026-11-01T00:00:00Z");
const inDays = (d: number) => new Date(now.getTime() + d * 86400000).toISOString();

describe("token life (decision 21)", () => {
  it("defaults to 90 days", () => {
    const r = resolveTokenExpiry(undefined, now);
    expect(r).toMatchObject({ ok: true, defaulted: true, expiresAt: inDays(90) });
  });
  it("accepts up to 365 days, refuses more, refuses the past", () => {
    expect(resolveTokenExpiry(inDays(365), now).ok).toBe(true);
    expect(resolveTokenExpiry(inDays(366), now).ok).toBe(false);
    expect(resolveTokenExpiry(inDays(-1), now).ok).toBe(false);
  });
  it("warns under 14 days, not for never-expiring or expired tokens", () => {
    expect(tokenExpiresSoon(inDays(13), now)).toBe(true);
    expect(tokenExpiresSoon(inDays(14), now)).toBe(false);
    expect(tokenExpiresSoon(null, now)).toBe(false);
    expect(tokenExpiresSoon(inDays(-2), now)).toBe(false);
    expect(tokenDaysLeft(null)).toBeNull();
  });
});

describe("Q-ACC-9", () => {
  it("a manager cannot revoke something an admin created; an admin can", () => {
    expect(() => assertCanRevokeCreatedBy("manager", "admin")).toThrow("Only an admin can revoke something an admin created.");
    expect(() => assertCanRevokeCreatedBy("admin", "admin")).not.toThrow();
    expect(() => assertCanRevokeCreatedBy("manager", "manager")).not.toThrow();
    expect(() => assertCanRevokeCreatedBy("manager", null)).not.toThrow();
  });
});

describe("Q-ACC-24 dead token log", () => {
  it("logs the first use per token per hour only", () => {
    const t = Date.now();
    expect(logDeadTokenUse("tok-a", "revoked", t)).toBe(true);
    expect(logDeadTokenUse("tok-a", "revoked", t + 1000)).toBe(false);
    expect(logDeadTokenUse("tok-a", "revoked", t + 3700_000)).toBe(true);
    expect(logDeadTokenUse("tok-b", "expired", t)).toBe(true);
  });
});

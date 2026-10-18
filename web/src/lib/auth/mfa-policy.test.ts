import { describe, it, expect } from "vitest";
import { evaluateMfaRequirement, isMfaGatedPath, MFA_GRACE_DAYS } from "./mfa-policy";

const now = new Date("2026-11-01T00:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();

describe("evaluateMfaRequirement (decision 22)", () => {
  it("members and viewers are never required", () => {
    for (const role of ["member", "viewer", null]) {
      expect(evaluateMfaRequirement({ role, enrolled: false, graceStartedAt: daysAgo(99), now }).mustEnrol).toBe(false);
    }
  });
  it("admin/manager inside the 14-day grace is not sent to enrol", () => {
    const r = evaluateMfaRequirement({ role: "manager", enrolled: false, graceStartedAt: daysAgo(3), now });
    expect(r).toMatchObject({ required: true, inGrace: true, mustEnrol: false, daysLeft: MFA_GRACE_DAYS - 3 });
  });
  it("admin/manager after the grace must enrol", () => {
    const r = evaluateMfaRequirement({ role: "admin", enrolled: false, graceStartedAt: daysAgo(15), now });
    expect(r).toMatchObject({ mustEnrol: true, inGrace: false, daysLeft: 0 });
  });
  it("an enrolled admin is fine at any time", () => {
    expect(evaluateMfaRequirement({ role: "admin", enrolled: true, graceStartedAt: daysAgo(99), now }).mustEnrol).toBe(false);
  });
  it("the shared demo login is exempt", () => {
    expect(evaluateMfaRequirement({ role: "admin", enrolled: false, graceStartedAt: daysAgo(99), isDemo: true, now }).required).toBe(false);
  });
  it("no clock yet (migration not applied) never locks anyone out", () => {
    expect(evaluateMfaRequirement({ role: "admin", enrolled: false, graceStartedAt: null, now }).mustEnrol).toBe(false);
  });
});

describe("isMfaGatedPath", () => {
  it("gates console areas but keeps settings, login, invite and API open", () => {
    expect(isMfaGatedPath("/projects/abc")).toBe(true);
    expect(isMfaGatedPath("/dashboard")).toBe(true);
    expect(isMfaGatedPath("/settings")).toBe(false);
    expect(isMfaGatedPath("/login")).toBe(false);
    expect(isMfaGatedPath("/invite/x")).toBe(false);
    expect(isMfaGatedPath("/api/projects")).toBe(false);
  });
});

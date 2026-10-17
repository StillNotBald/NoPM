import { describe, it, expect } from "vitest";
import type { Actor } from "@/lib/auth/guard";
import { assertMayActForMemberHours } from "./_own";

const base = { label: "x", workspaceId: "w" };
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("assertMayActForMemberHours (D-17)", () => {
  it("lets a member act on their own row", () => {
    const a: Actor = { ...base, type: "user", id: ME, role: "member", principalId: ME };
    expect(() => assertMayActForMemberHours(a, { profile_id: ME })).not.toThrow();
  });
  it("refuses a member acting on someone else's row", () => {
    const a: Actor = { ...base, type: "user", id: ME, role: "member", principalId: ME };
    expect(() => assertMayActForMemberHours(a, { profile_id: OTHER })).toThrow(
      "You can only log your own hours",
    );
  });
  it("refuses a member on an unlinked resource row", () => {
    const a: Actor = { ...base, type: "user", id: ME, role: "member", principalId: ME };
    expect(() => assertMayActForMemberHours(a, { profile_id: null })).toThrow();
  });
  it("lets admins and managers act for others", () => {
    for (const role of ["admin", "manager"]) {
      const a: Actor = { ...base, type: "user", id: ME, role, principalId: ME };
      expect(() => assertMayActForMemberHours(a, { profile_id: OTHER })).not.toThrow();
    }
  });
  it("uses the human behind a token", () => {
    const tok = { ...base, type: "token", id: "t", principalId: ME } as Actor;
    expect(() => assertMayActForMemberHours(tok, { profile_id: ME })).not.toThrow();
    expect(() => assertMayActForMemberHours(tok, { profile_id: OTHER })).toThrow();
    const mgr = { ...tok, principalRole: "manager" } as Actor;
    expect(() => assertMayActForMemberHours(mgr, { profile_id: OTHER })).not.toThrow();
  });
  it("fails closed for an owner-less token", () => {
    const tok = { ...base, type: "token", id: "t", principalId: null } as Actor;
    expect(() => assertMayActForMemberHours(tok, { profile_id: ME })).toThrow();
  });
});

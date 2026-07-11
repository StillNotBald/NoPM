import { describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/guard";
import { scopesForActor } from "./token";
import { TOOL_SCOPES } from "./tools";

const actor = (role?: string): Actor =>
  ({ type: "user", id: "u1", workspaceId: "w1", label: "Test", role }) as Actor;

describe("scopesForActor — least-privilege ephemeral token scopes", () => {
  it("grants viewers ONLY read scopes (assistant must not be a write side door)", () => {
    const scopes = scopesForActor(actor("viewer"));
    expect(scopes.length).toBeGreaterThan(0);
    for (const s of scopes) {
      expect(s.endsWith(":read")).toBe(true);
    }
    expect(scopes).not.toContain("task:delete:request");
    expect(scopes).not.toContain("project:write");
  });

  it("grants members/managers/admins the full tool scope set", () => {
    for (const role of ["member", "manager", "admin"]) {
      expect(scopesForActor(actor(role))).toEqual([...TOOL_SCOPES]);
    }
  });

  it("never grants an approve/admin scope to anyone (R-60 invariant)", () => {
    for (const role of ["viewer", "member", "manager", "admin", undefined]) {
      const scopes = scopesForActor(actor(role));
      for (const s of scopes) {
        expect(s).not.toMatch(/approve|admin|token/);
      }
    }
  });
});

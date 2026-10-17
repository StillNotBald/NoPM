import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth/guard";

const { insertSpy } = vi.hoisted(() => ({ insertSpy: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== "api_tokens") throw new Error(`unexpected table: ${table}`);
      return {
        insert: (row: Record<string, unknown>) => {
          insertSpy(row);
          return { select: () => ({ single: async () => ({ data: { id: "tok-new" }, error: null }) }) };
        },
      };
    },
  }),
}));

import { mintEphemeralToken, scopesForActor } from "./token";
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

// Four-eyes compares HUMANS (2026-10-16): the ephemeral token must record whose
// assistant it is, or "the assistant requested it, the same person approved it"
// could not be detected and the token itself could never approve (no principal).
describe("mintEphemeralToken — records the human it acts for", () => {
  beforeEach(() => insertSpy.mockClear());

  it("created_by is the signed-in user's profile id", async () => {
    const res = await mintEphemeralToken({
      type: "user",
      id: "user-7",
      principalId: "user-7",
      workspaceId: "w1",
      label: "Pat",
      role: "member",
    } as Actor);
    expect(res.id).toBe("tok-new");
    const [row] = insertSpy.mock.calls[0];
    expect(row.created_by).toBe("user-7");
    expect(row.workspace_id).toBe("w1");
    expect(row.name).toBe("AI Assistant · Pat");
    // The reliable marker the Tokens list hides by (0052) — the name is only a label.
    expect(row.kind).toBe("assistant");
    // and it never carries a checker scope (R-60)
    for (const s of row.scopes as string[]) expect(s).not.toMatch(/approve|decide/);
  });

  it("falls back to the user's own id when the Actor was built without a principal", async () => {
    await mintEphemeralToken({ type: "user", id: "user-8", workspaceId: "w1", label: "Q", role: "member" } as Actor);
    expect(insertSpy.mock.calls[0][0].created_by).toBe("user-8");
  });

  it("never records a token id as created_by (api_tokens.created_by is a profile FK)", async () => {
    await mintEphemeralToken({ type: "token", id: "tok-9", workspaceId: "w1", label: "T", scopes: [] } as Actor);
    expect(insertSpy.mock.calls[0][0].created_by).toBeNull();
  });
});

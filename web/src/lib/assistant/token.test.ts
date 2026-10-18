import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth/guard";

const { insertSpy, updateSpy, writeAuditMock } = vi.hoisted(() => ({
  insertSpy: vi.fn(),
  updateSpy: vi.fn(),
  writeAuditMock: vi.fn(async (_input: Record<string, unknown>) => {}),
}));
vi.mock("@/lib/audit/write", () => ({ writeAudit: writeAuditMock }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== "api_tokens") throw new Error(`unexpected table: ${table}`);
      return {
        insert: (row: Record<string, unknown>) => {
          insertSpy(row);
          return { select: () => ({ single: async () => ({ data: { id: "tok-new" }, error: null }) }) };
        },
        update: (patch: Record<string, unknown>) => ({
          eq: async (col: string, val: string) => {
            updateSpy(patch, col, val);
            return { error: null };
          },
        }),
      };
    },
  }),
}));

import { EPHEMERAL_TOKEN_TTL_MS, mintEphemeralToken, revokeEphemeralToken, scopesForActor } from "./token";
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

describe("ephemeral token lifecycle audit (A1-10, A3-14)", () => {
  const user = { type: "user", id: "u1", principalId: "u1", workspaceId: "w1", label: "Pat", role: "member" } as Actor;
  beforeEach(() => {
    insertSpy.mockClear();
    updateSpy.mockClear();
    writeAuditMock.mockClear();
    writeAuditMock.mockImplementation(async () => {});
  });

  it("expires after the longest possible turn (10 minutes), not an hour", async () => {
    expect(EPHEMERAL_TOKEN_TTL_MS).toBe(10 * 60 * 1000);
    const before = Date.now();
    await mintEphemeralToken(user);
    const exp = new Date(insertSpy.mock.calls[0][0].expires_at as string).getTime();
    expect(exp - before).toBeLessThanOrEqual(EPHEMERAL_TOKEN_TTL_MS + 1000);
    expect(exp - before).toBeGreaterThan(EPHEMERAL_TOKEN_TTL_MS - 5000);
  });

  it("writes exactly one mint audit row that links the conversation id", async () => {
    await mintEphemeralToken(user, { conversationId: "conv-1" });
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const arg = writeAuditMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.action).toBe("assistant.token.mint");
    expect(arg.targetId).toBe("conv-1");
    expect(arg.after).toMatchObject({ token_id: "tok-new", conversation_id: "conv-1" });
  });

  it("revokes the token and refuses the turn when the mint cannot be audited (fail-closed)", async () => {
    writeAuditMock.mockImplementationOnce(async () => {
      throw new Error("audit down");
    });
    await expect(mintEphemeralToken(user, { conversationId: "conv-1" })).rejects.toThrow(/audit down/);
    expect(updateSpy).toHaveBeenCalledWith({ revoked: true }, "id", "tok-new");
  });

  it("revoke marks the token revoked and writes one revoke audit row with the conversation id", async () => {
    await revokeEphemeralToken("tok-new", { actor: user, conversationId: "conv-1" });
    expect(updateSpy).toHaveBeenCalledWith({ revoked: true }, "id", "tok-new");
    expect(writeAuditMock).toHaveBeenCalledTimes(1);
    const arg = writeAuditMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.action).toBe("assistant.token.revoke");
    expect(arg.targetId).toBe("conv-1");
    expect(arg.after).toMatchObject({ token_id: "tok-new", conversation_id: "conv-1" });
  });

  it("a failing revoke audit never throws out of a finally block", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeAuditMock.mockImplementationOnce(async () => {
      throw new Error("audit down");
    });
    await expect(revokeEphemeralToken("tok-new", { actor: user })).resolves.toBeUndefined();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth/guard";

// The token row and its audit row are written by ONE database function now (nopm_mutate_audited, migration 0103),
// so the stub records the RPC call: the patch is the row, p_audit is the audit row's description.
const { rpcCalls, rpcResult, updateSpy } = vi.hoisted(() => ({
  rpcCalls: [] as { fn: string; args: Record<string, any> }[], // eslint-disable-line @typescript-eslint/no-explicit-any
  rpcResult: { error: null as null | { message: string } },
  updateSpy: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (rpcResult.error) return { data: null, error: rpcResult.error };
      const patch = (args.p_patch ?? {}) as Record<string, unknown>;
      const row = { id: args.p_id, workspace_id: args.p_workspace_id, ...patch };
      return { data: { before: args.p_op === "insert" ? null : row, after: row }, error: null };
    },
    from: (table: string) => {
      if (table !== "api_tokens") throw new Error(`unexpected table: ${table}`);
      const filters: [string, string][] = [];
      const builder = {
        eq: (col: string, val: string) => {
          filters.push([col, val]);
          return builder;
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
      };
      return {
        update: (patch: Record<string, unknown>) => {
          updateSpy(patch, filters);
          return builder;
        },
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

const mintCall = () => rpcCalls.find((c) => c.args.p_op === "insert")!;

// Four-eyes compares HUMANS (2026-10-16): the ephemeral token must record whose
// assistant it is, or "the assistant requested it, the same person approved it"
// could not be detected and the token itself could never approve (no principal).
describe("mintEphemeralToken — records the human it acts for", () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    rpcResult.error = null;
  });

  it("created_by is the signed-in user's profile id", async () => {
    const res = await mintEphemeralToken({
      type: "user",
      id: "user-7",
      principalId: "user-7",
      workspaceId: "w1",
      label: "Pat",
      role: "member",
    } as Actor);
    expect(res.id).toBe(mintCall().args.p_id);
    const row = mintCall().args.p_patch;
    expect(row.created_by).toBe("user-7");
    expect(mintCall().args.p_workspace_id).toBe("w1");
    expect(mintCall().args.p_table).toBe("api_tokens");
    expect(row.name).toBe("AI Assistant · Pat");
    // The reliable marker the Tokens list hides by (0052) — the name is only a label.
    expect(row.kind).toBe("assistant");
    // and it never carries a checker scope (R-60)
    for (const s of row.scopes as string[]) expect(s).not.toMatch(/approve|decide/);
  });

  it("falls back to the user's own id when the Actor was built without a principal", async () => {
    await mintEphemeralToken({ type: "user", id: "user-8", workspaceId: "w1", label: "Q", role: "member" } as Actor);
    expect(mintCall().args.p_patch.created_by).toBe("user-8");
  });

  it("never records a token id as created_by (api_tokens.created_by is a profile FK)", async () => {
    await mintEphemeralToken({ type: "token", id: "tok-9", workspaceId: "w1", label: "T", scopes: [] } as Actor);
    expect(mintCall().args.p_patch.created_by).toBeNull();
  });
});

describe("ephemeral token lifecycle audit (A1-10, A3-14)", () => {
  const user = { type: "user", id: "u1", principalId: "u1", workspaceId: "w1", label: "Pat", role: "member" } as Actor;
  beforeEach(() => {
    rpcCalls.length = 0;
    updateSpy.mockClear();
    rpcResult.error = null;
  });

  it("expires after the longest possible turn (10 minutes), not an hour", async () => {
    expect(EPHEMERAL_TOKEN_TTL_MS).toBe(10 * 60 * 1000);
    const before = Date.now();
    await mintEphemeralToken(user);
    const exp = new Date(mintCall().args.p_patch.expires_at as string).getTime();
    expect(exp - before).toBeLessThanOrEqual(EPHEMERAL_TOKEN_TTL_MS + 1000);
    expect(exp - before).toBeGreaterThan(EPHEMERAL_TOKEN_TTL_MS - 5000);
  });

  it("writes the token and exactly one mint audit row in ONE call, linked to the conversation, without the hash", async () => {
    const res = await mintEphemeralToken(user, { conversationId: "conv-1" });
    expect(rpcCalls).toHaveLength(1);
    const audit = mintCall().args.p_audit;
    expect(audit.action).toBe("assistant.token.mint");
    expect(audit.target_type).toBe("assistant_conversation");
    expect(audit.target_id).toBe("conv-1");
    expect(audit.after).toMatchObject({ token_id: res.id, conversation_id: "conv-1" });
    // the token hash is written but never read into the audit row or returned
    expect(audit.omit_columns).toEqual(["token_hash"]);
    expect(JSON.stringify(audit)).not.toContain(mintCall().args.p_patch.token_hash);
    // no separate update, no separate audit call
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("refuses the turn when the mint cannot be audited, and no token row exists to clean up (fail-closed)", async () => {
    rpcResult.error = { message: "audit down" };
    await expect(mintEphemeralToken(user, { conversationId: "conv-1" })).rejects.toThrow(/audit down/);
    // the insert and the audit row are one transaction: nothing to revoke afterwards
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("revoke marks the token revoked and writes one revoke audit row with the conversation id, in one call", async () => {
    await revokeEphemeralToken("tok-new", { actor: user, conversationId: "conv-1" });
    expect(rpcCalls).toHaveLength(1);
    const call = rpcCalls[0].args;
    expect(call.p_op).toBe("update");
    expect(call.p_id).toBe("tok-new");
    expect(call.p_patch).toEqual({ revoked: true });
    expect(call.p_audit.action).toBe("assistant.token.revoke");
    expect(call.p_audit.target_id).toBe("conv-1");
    expect(call.p_audit.after).toMatchObject({ token_id: "tok-new", conversation_id: "conv-1" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("a revoke whose audit write fails still revokes the token (security first) and never throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    rpcResult.error = { message: "audit down" };
    await expect(revokeEphemeralToken("tok-new", { actor: user })).resolves.toBeUndefined();
    expect(updateSpy).toHaveBeenCalledWith({ revoked: true }, [
      ["id", "tok-new"],
      ["workspace_id", "w1"],
    ]);
  });

  it("revoke without an actor just revokes (no audit row is described)", async () => {
    await revokeEphemeralToken("tok-new");
    expect(rpcCalls).toHaveLength(0);
    expect(updateSpy).toHaveBeenCalledWith({ revoked: true }, [["id", "tok-new"]]);
  });
});

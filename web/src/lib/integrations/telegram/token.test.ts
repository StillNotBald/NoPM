import { describe, it, expect, vi, beforeEach } from "vitest";
import { fixtureConnector, profile } from "./fixtures";
import { APPROVABLE_DELETION_TYPES } from "./commands";

const auditedUpdate = vi.fn(async () => ({}));
const writeAudit = vi.fn(async () => {});
const updates: Record<string, unknown>[] = [];
let plainRevokeFails = false;

vi.mock("@/lib/audit/audited-write", () => ({
  auditedInsert: vi.fn(async () => ({})),
  auditedUpdate: (...a: unknown[]) => (auditedUpdate as (...x: unknown[]) => Promise<unknown>)(...a),
}));
vi.mock("@/lib/audit/write", () => ({ writeAudit: (...a: unknown[]) => (writeAudit as (...x: unknown[]) => Promise<void>)(...a) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        const q: Record<string, unknown> = {
          eq: () => q,
          then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => (plainRevokeFails ? reject(new Error("db down")) : resolve({ error: null })),
        };
        return q;
      },
    }),
  }),
}));

import { assertAllowedScopes, isReadOnlyScopes, revokeActionToken } from "./token";

beforeEach(() => {
  auditedUpdate.mockReset().mockResolvedValue({});
  writeAudit.mockReset().mockResolvedValue(undefined);
  updates.length = 0;
  plainRevokeFails = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("revokeActionToken audit shape (review round 1, N-8)", () => {
  it("a write token's revoke is audited in the same transaction", async () => {
    await revokeActionToken(fixtureConnector(), profile(), "tok", { audit: true });
    expect(auditedUpdate).toHaveBeenCalledTimes(1);
    expect(writeAudit).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("a read-only token's revoke adds no audit row (the mint row is its one row)", async () => {
    await revokeActionToken(fixtureConnector(), profile(), "tok", { audit: false });
    expect(auditedUpdate).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
    expect(updates).toEqual([{ revoked: true }]);
  });

  it("when the audited revoke fails the token is still revoked AND a fallback audit row is written", async () => {
    auditedUpdate.mockRejectedValueOnce(new Error("rpc down"));
    await revokeActionToken(fixtureConnector(), profile(), "tok");
    expect(updates).toEqual([{ revoked: true }]);
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "telegram.token.revoke", targetId: "tok", after: expect.objectContaining({ fallback: true }) }));
  });

  it("never throws, even when the fallback revoke and its audit row both fail", async () => {
    auditedUpdate.mockRejectedValueOnce(new Error("rpc down"));
    plainRevokeFails = true;
    await expect(revokeActionToken(fixtureConnector(), profile(), "tok")).resolves.toBeUndefined();
    auditedUpdate.mockRejectedValueOnce(new Error("rpc down"));
    plainRevokeFails = false;
    writeAudit.mockRejectedValueOnce(new Error("audit down"));
    await expect(revokeActionToken(fixtureConnector(), profile(), "tok")).resolves.toBeUndefined();
  });
});

describe("scopes", () => {
  it("isReadOnlyScopes is true only for read scopes", () => {
    expect(isReadOnlyScopes(["task:read", "project:read"])).toBe(true);
    expect(isReadOnlyScopes(["task:write"])).toBe(false);
    expect(isReadOnlyScopes(["task:read", "task:write"])).toBe(false);
    expect(isReadOnlyScopes([])).toBe(false);
  });

  it("the handlers' decidable types are exactly the approve scopes the token allow-list accepts", () => {
    for (const t of APPROVABLE_DELETION_TYPES) expect(() => assertAllowedScopes([`${t}:delete:approve`])).not.toThrow();
    for (const t of ["program", "sprint", "resource", "allocation", "clash"]) expect(() => assertAllowedScopes([`${t}:delete:approve`])).toThrow();
  });
});

import { describe, it, expect, vi } from "vitest";
import type { Actor } from "@/lib/auth/guard";

vi.mock("@/lib/audit/write", () => ({ writeAudit: vi.fn(async () => {}) }));

import { assertMayAccept, assertNoSupersedeLoop, isFrozen } from "./_rules";

const user = (role: string) => ({ type: "user", id: "u", label: "u", workspaceId: "w", role }) as Actor;
const token = (principalRole: string | null) =>
  ({ type: "token", id: "t", label: "t", workspaceId: "w", principalRole }) as Actor;

describe("assertMayAccept", () => {
  it("lets managers and admins accept", () => {
    expect(() => assertMayAccept(user("manager"), "accepted")).not.toThrow();
    expect(() => assertMayAccept(user("admin"), "accepted")).not.toThrow();
  });
  it("refuses members with the plain message", () => {
    expect(() => assertMayAccept(user("member"), "accepted")).toThrow(
      "Only a manager or admin can mark a decision accepted.",
    );
  });
  it("judges a token by the human behind it", () => {
    expect(() => assertMayAccept(token("member"), "accepted")).toThrow();
    expect(() => assertMayAccept(token(null), "accepted")).toThrow();
    expect(() => assertMayAccept(token("manager"), "accepted")).not.toThrow();
  });
  it("lets anyone propose", () => {
    expect(() => assertMayAccept(user("member"), "proposed")).not.toThrow();
    expect(() => assertMayAccept(user("member"), undefined)).not.toThrow();
  });
});

describe("isFrozen", () => {
  it("freezes accepted and superseded only", () => {
    expect(isFrozen("accepted")).toBe(true);
    expect(isFrozen("superseded")).toBe(true);
    expect(isFrozen("proposed")).toBe(false);
    expect(isFrozen("rejected")).toBe(false);
  });
});

function chainDb(links: Record<string, string | null>) {
  return {
    from: () => {
      let id = "";
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (col: string, v: string) => {
        if (col === "id") id = v;
        return b;
      };
      b.maybeSingle = async () => ({ data: id in links ? { supersedes: links[id] } : null });
      return b;
    },
  };
}

describe("assertNoSupersedeLoop", () => {
  it("accepts a clean chain", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(assertNoSupersedeLoop(chainDb({ b: "c", c: null }) as any, "w", "b", "a")).resolves.toBeUndefined();
  });
  it("refuses when the replaced decision already replaces this one", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(assertNoSupersedeLoop(chainDb({ b: "c", c: "a", a: null }) as any, "w", "b", "a")).rejects.toThrow(
      /loop/,
    );
  });
  it("refuses a pre-existing cycle that does not include this decision", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(assertNoSupersedeLoop(chainDb({ b: "c", c: "b" }) as any, "w", "b", "a")).rejects.toThrow(/loop/);
  });
});

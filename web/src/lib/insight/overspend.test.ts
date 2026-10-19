import { describe, it, expect, vi } from "vitest";
import type { Actor } from "@/lib/auth/guard";
import { overspendLevel, recordOverspendCrossing } from "./overspend";

const actor = { type: "user", id: "u", label: "u", workspaceId: "w", role: "member" } as Actor;

type RpcCall = { fn: string; args: Record<string, unknown> };

/**
 * Stand-in for the admin client. Reads (budget, expenses) are canned. The crossing is ONE rpc call
 * (nopm_overspend_cross, R-165): `claim` is what the SQL compare-and-set returns, `rpcError` makes
 * the whole transaction (marker change and audit row) fail.
 */
function fakeDb(budget: Record<string, unknown> | null, amounts: number[], claim = true, rpcError: { message: string } | null = null) {
  const state = { rpc: [] as RpcCall[], writes: 0 };
  return {
    state,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpc.push({ fn, args });
      return { data: rpcError ? null : claim, error: rpcError };
    },
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: budget });
      // A direct write would bypass the atomic RPC: count it so a test can prove there is none.
      for (const m of ["update", "insert", "upsert", "delete"]) b[m] = () => (state.writes++, b);
      if (table === "expenses") {
        (b as { then?: unknown }).then = (res: (v: unknown) => void) =>
          res({ data: amounts.map((amount) => ({ amount })) });
      }
      return b;
    },
  };
}

describe("overspendLevel", () => {
  it("is ok below the warn percentage", () => expect(overspendLevel(1000, 899)).toBe("ok"));
  it("warns at 90% by default", () => expect(overspendLevel(1000, 900)).toBe("warn"));
  it("is over at 100%", () => expect(overspendLevel(1000, 1000)).toBe("over"));
  it("honours a custom warn percentage", () => expect(overspendLevel(1000, 800, 80)).toBe("warn"));
  it("never warns without a plan", () => expect(overspendLevel(0, 500)).toBe("ok"));
});

describe("recordOverspendCrossing", () => {
  it("makes ONE atomic call carrying the previous and next level and the audit payload", async () => {
    const db = fakeDb({ planned_amount: 1000, overspend_level: "ok", overspend_warn_pct: 90 }, [500, 450]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const level = await recordOverspendCrossing(db as any, actor, "p");
    expect(level).toBe("warn");
    expect(db.state.rpc).toHaveLength(1);
    const { fn, args } = db.state.rpc[0];
    expect(fn).toBe("nopm_overspend_cross");
    expect(args).toMatchObject({ p_workspace_id: "w", p_project_id: "p", p_previous: "ok", p_next: "warn" });
    expect(args.p_after).toEqual({ level: "warn", planned_amount: 1000, actual: 950, burn_pct: 95, warn_pct: 90 });
    expect(args.p_audit).toMatchObject({ action: "budget.overspend", target_type: "project_budget", actor_type: "user", actor_id: "u" });
    expect(db.state.writes).toBe(0); // no direct marker write, no separate audit write
  });
  it("is best effort: a failing transaction (marker change and audit row roll back together) is swallowed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = fakeDb({ planned_amount: 1000, overspend_level: "ok", overspend_warn_pct: 90 }, [950], true, { message: "audit down" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await recordOverspendCrossing(db as any, actor, "p")).toBeNull();
    expect(db.state.writes).toBe(0); // nothing to give back: the claim never survived the failed audit write
  });
  it("calls nothing when the level is unchanged", async () => {
    const db = fakeDb({ planned_amount: 1000, overspend_level: "warn", overspend_warn_pct: 90 }, [950]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordOverspendCrossing(db as any, actor, "p");
    expect(db.state.rpc).toHaveLength(0);
  });
  it("still reports the new level when another request already claimed the crossing (the RPC wrote nothing)", async () => {
    const db = fakeDb({ planned_amount: 1000, overspend_level: "ok", overspend_warn_pct: 90 }, [1200], false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await recordOverspendCrossing(db as any, actor, "p")).toBe("over");
    expect(db.state.rpc).toHaveLength(1);
    expect(db.state.writes).toBe(0);
  });
  it("compares against the previous NON-null level (a warn marker moving to over)", async () => {
    const db = fakeDb({ planned_amount: 1000, overspend_level: "warn", overspend_warn_pct: 90 }, [1000]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordOverspendCrossing(db as any, actor, "p");
    expect(db.state.rpc[0].args).toMatchObject({ p_previous: "warn", p_next: "over" });
  });
  it("swallows failures (never blocks)", async () => {
    const db = {
      from: () => {
        throw new Error("boom");
      },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await recordOverspendCrossing(db as any, actor, "p")).toBeNull();
  });
});

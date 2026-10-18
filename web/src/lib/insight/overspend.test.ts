import { describe, it, expect, vi } from "vitest";
import type { Actor } from "@/lib/auth/guard";

const audits: Record<string, unknown>[] = [];
vi.mock("@/lib/audit/write", () => ({
  writeAudit: vi.fn(async (a: Record<string, unknown>) => {
    audits.push(a);
  }),
}));

import { overspendLevel, recordOverspendCrossing } from "./overspend";

const actor = { type: "user", id: "u", label: "u", workspaceId: "w", role: "member" } as Actor;

function fakeDb(budget: Record<string, unknown> | null, amounts: number[], claim = true) {
  const state = { updated: [] as unknown[] };
  return {
    state,
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: budget });
      b.update = (v: unknown) => {
        state.updated.push(v);
        const u: Record<string, unknown> = {};
        u.eq = () => u;
        u.select = async () => ({ data: claim ? [{ project_id: "p" }] : [] });
        return u;
      };
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
  it("gives the claimed level back when the audit row cannot be written (R3-8)", async () => {
    const { writeAudit } = await import("@/lib/audit/write");
    vi.mocked(writeAudit).mockRejectedValueOnce(new Error("audit down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = fakeDb({ planned_amount: 1000, overspend_level: "ok", overspend_warn_pct: 90 }, [950]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await recordOverspendCrossing(db as any, actor, "p")).toBeNull();
    expect(db.state.updated).toEqual([{ overspend_level: "warn" }, { overspend_level: "ok" }]);
  });
  it("writes one audit row when the level changes", async () => {
    audits.length = 0;
    const db = fakeDb({ planned_amount: 1000, overspend_level: "ok", overspend_warn_pct: 90 }, [500, 450]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const level = await recordOverspendCrossing(db as any, actor, "p");
    expect(level).toBe("warn");
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("budget.overspend");
    expect(db.state.updated).toEqual([{ overspend_level: "warn" }]);
  });
  it("writes nothing when the level is unchanged", async () => {
    audits.length = 0;
    const db = fakeDb({ planned_amount: 1000, overspend_level: "warn", overspend_warn_pct: 90 }, [950]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordOverspendCrossing(db as any, actor, "p");
    expect(audits).toHaveLength(0);
  });
  it("writes nothing when another request already claimed the crossing", async () => {
    audits.length = 0;
    const db = fakeDb({ planned_amount: 1000, overspend_level: "ok", overspend_warn_pct: 90 }, [1200], false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordOverspendCrossing(db as any, actor, "p");
    expect(audits).toHaveLength(0);
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

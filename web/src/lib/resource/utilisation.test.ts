import { describe, it, expect } from "vitest";
import {
  memberUtilisation,
  workspaceSummary,
  fmtHours,
  type WorkspaceMemberInput,
} from "./utilisation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function member(capacityHoursPerWeek: number | null, totalAllocationPct: number): WorkspaceMemberInput {
  return { capacityHoursPerWeek, totalAllocationPct };
}

// ---------------------------------------------------------------------------
// memberUtilisation — the ordinary band
// ---------------------------------------------------------------------------
describe("memberUtilisation — allocated vs free hours", () => {
  it("splits capacity by allocation percentage", () => {
    expect(memberUtilisation(50, 40)).toEqual({
      allocatedPct: 50,
      allocatedHours: 20,
      freeHours: 20,
      isOver: false,
    });
  });

  it("zero allocation leaves the whole week free", () => {
    const r = memberUtilisation(0, 40);
    expect(r.allocatedHours).toBe(0);
    expect(r.freeHours).toBe(40);
    expect(r.isOver).toBe(false);
  });

  it("exactly 100 % consumes capacity but is NOT flagged as over (strict >)", () => {
    const r = memberUtilisation(100, 40);
    expect(r.allocatedHours).toBe(40);
    expect(r.freeHours).toBe(0);
    expect(r.isOver).toBe(false);
  });

  it("passes allocatedPct through untouched — it is not clamped or rounded", () => {
    expect(memberUtilisation(137.5, 40).allocatedPct).toBe(137.5);
    expect(memberUtilisation(-25, 40).allocatedPct).toBe(-25);
  });

  it("rounds hours to one decimal place", () => {
    const r = memberUtilisation(33, 40);
    expect(r.allocatedHours).toBe(13.2);
    expect(r.freeHours).toBe(26.8);
  });

  it("rounds each side independently, so the pair can exceed capacity by 0.1", () => {
    // 37 % of 37.5h = 13.875 → 13.9;  free = 23.625 → 23.6
    const r = memberUtilisation(37, 37.5);
    expect(r.allocatedHours).toBe(13.9);
    expect(r.freeHours).toBe(23.6);
    expect(r.allocatedHours! + r.freeHours!).toBeCloseTo(37.5, 10);
  });
});

// ---------------------------------------------------------------------------
// memberUtilisation — over-allocation
// ---------------------------------------------------------------------------
describe("memberUtilisation — over-allocation", () => {
  it("flags allocation above 100 % and reports negative free hours", () => {
    const r = memberUtilisation(150, 40);
    expect(r.isOver).toBe(true);
    expect(r.allocatedHours).toBe(60);
    expect(r.freeHours).toBe(-20);
  });

  it("flags a hair over 100 %", () => {
    expect(memberUtilisation(100.1, 40).isOver).toBe(true);
  });

  it("flags over-allocation even when capacity is unknown", () => {
    const r = memberUtilisation(180, null);
    expect(r.isOver).toBe(true);
    expect(r.allocatedHours).toBeNull();
    expect(r.freeHours).toBeNull();
  });

  it("handles extreme over-allocation without overflow", () => {
    const r = memberUtilisation(1000, 40);
    expect(r.allocatedHours).toBe(400);
    expect(r.freeHours).toBe(-360);
  });
});

// ---------------------------------------------------------------------------
// memberUtilisation — degenerate capacity
// ---------------------------------------------------------------------------
describe("memberUtilisation — degenerate capacity", () => {
  it("null capacity yields null hours rather than guessing", () => {
    expect(memberUtilisation(50, null)).toEqual({
      allocatedPct: 50,
      allocatedHours: null,
      freeHours: null,
      isOver: false,
    });
  });

  it("undefined capacity takes the same branch as null (loose == is deliberate)", () => {
    const r = memberUtilisation(50, undefined as unknown as null);
    expect(r.allocatedHours).toBeNull();
    expect(r.freeHours).toBeNull();
  });

  it("ZERO capacity is a real value, not a missing one — no divide-by-zero occurs", () => {
    // Capacity is a multiplicand here, so 0 h capacity is arithmetically safe.
    const r = memberUtilisation(75, 0);
    expect(r.allocatedHours).toBe(0);
    expect(r.freeHours).toBe(0);
    expect(r.isOver).toBe(false);
  });

  it("zero capacity with over-allocation still flags, still reports 0 hours", () => {
    const r = memberUtilisation(200, 0);
    expect(r.isOver).toBe(true);
    expect(r.allocatedHours).toBe(0);
    expect(r.freeHours).toBe(0);
  });

  it("negative allocation gives back more free hours than capacity", () => {
    const r = memberUtilisation(-50, 40);
    expect(r.allocatedHours).toBe(-20);
    expect(r.freeHours).toBe(60);
    expect(r.isOver).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// workspaceSummary — empty and all-null rollups
// ---------------------------------------------------------------------------
describe("workspaceSummary — empty / capacity-less workspaces", () => {
  it("an empty workspace has null overall utilisation, not NaN or 0", () => {
    expect(workspaceSummary([])).toEqual({
      totalCapacityHours: 0,
      totalAllocatedHours: 0,
      overallUtilisationPct: null,
      membersOverCapacity: 0,
    });
  });

  it("null overall utilisation when nobody has declared capacity (divide-by-zero guard)", () => {
    const s = workspaceSummary([member(null, 50), member(null, 80)]);
    expect(s.totalCapacityHours).toBe(0);
    expect(s.overallUtilisationPct).toBeNull();
  });

  it("counts over-capacity members even when none of them have capacity hours", () => {
    const s = workspaceSummary([member(null, 150), member(null, 20), member(null, 101)]);
    expect(s.membersOverCapacity).toBe(2);
    expect(s.overallUtilisationPct).toBeNull();
  });

  it("all-zero capacities also produce null utilisation (guard is > 0, not != null)", () => {
    const s = workspaceSummary([member(0, 50), member(0, 200)]);
    expect(s.totalCapacityHours).toBe(0);
    expect(s.totalAllocatedHours).toBe(0);
    expect(s.overallUtilisationPct).toBeNull();
    expect(s.membersOverCapacity).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// workspaceSummary — rollup arithmetic
// ---------------------------------------------------------------------------
describe("workspaceSummary — rollup across members", () => {
  it("sums capacity and allocated hours, then derives overall utilisation", () => {
    const s = workspaceSummary([member(40, 50), member(40, 100)]);
    expect(s.totalCapacityHours).toBe(80);
    expect(s.totalAllocatedHours).toBe(60);
    expect(s.overallUtilisationPct).toBe(75);
    expect(s.membersOverCapacity).toBe(0);
  });

  it("members without capacity contribute neither capacity nor hours", () => {
    const s = workspaceSummary([member(null, 50), member(40, 50)]);
    expect(s.totalCapacityHours).toBe(40);
    expect(s.totalAllocatedHours).toBe(20);
    expect(s.overallUtilisationPct).toBe(50);
  });

  it("overall utilisation can exceed 100 % when the workspace is oversubscribed", () => {
    const s = workspaceSummary([member(40, 200)]);
    expect(s.totalAllocatedHours).toBe(80);
    expect(s.overallUtilisationPct).toBe(200);
    expect(s.membersOverCapacity).toBe(1);
  });

  it("an idle workspace reports 0 % (a real number), not null", () => {
    const s = workspaceSummary([member(40, 0), member(37.5, 0)]);
    expect(s.totalCapacityHours).toBe(77.5);
    expect(s.totalAllocatedHours).toBe(0);
    expect(s.overallUtilisationPct).toBe(0);
  });

  it("over-capacity count is per member, independent of the hours rollup", () => {
    const s = workspaceSummary([
      member(40, 120), // over, with capacity
      member(null, 130), // over, without capacity
      member(40, 100), // exactly at the line → not over
      member(40, 10),
    ]);
    expect(s.membersOverCapacity).toBe(2);
    expect(s.totalCapacityHours).toBe(120);
    expect(s.totalAllocatedHours).toBe(48 + 40 + 4);
  });

  it("rounds the rollup to one decimal and utilisation to one decimal", () => {
    // 37.5h @ 33 % = 12.375 → 12.4 ; 12.4 / 37.5 = 33.066… → 33.1
    const s = workspaceSummary([member(37.5, 33)]);
    expect(s.totalCapacityHours).toBe(37.5);
    expect(s.totalAllocatedHours).toBe(12.4);
    expect(s.overallUtilisationPct).toBe(33.1);
  });

  it("scales to many members without float drift in the totals", () => {
    const s = workspaceSummary(Array.from({ length: 10 }, () => member(37.5, 60)));
    expect(s.totalCapacityHours).toBe(375);
    expect(s.totalAllocatedHours).toBe(225);
    expect(s.overallUtilisationPct).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// fmtHours
// ---------------------------------------------------------------------------
describe("fmtHours", () => {
  it("drops the decimal for whole numbers", () => {
    expect(fmtHours(40)).toBe("40");
    expect(fmtHours(0)).toBe("0");
    expect(fmtHours(1)).toBe("1");
  });

  it("keeps one decimal place for fractional values", () => {
    expect(fmtHours(13.2)).toBe("13.2");
    expect(fmtHours(0.5)).toBe("0.5");
  });

  it("rounds to one decimal place rather than truncating", () => {
    expect(fmtHours(13.25)).toBe("13.3");
    expect(fmtHours(0.05)).toBe("0.1");
    expect(fmtHours(0.04)).toBe("0.0");
  });

  it("renders a near-whole number as '2.0' — the '.0' is only dropped for exact integers", () => {
    expect(fmtHours(2.04)).toBe("2.0");
    expect(fmtHours(1.999)).toBe("2.0");
  });

  it("formats negative (over-allocated) hours", () => {
    expect(fmtHours(-20)).toBe("-20");
    expect(fmtHours(-20.5)).toBe("-20.5");
  });

  it("normalises negative zero to '0'", () => {
    expect(fmtHours(-0)).toBe("0");
  });

  it("passes non-finite values straight through as their string form", () => {
    expect(fmtHours(NaN)).toBe("NaN");
    expect(fmtHours(Infinity)).toBe("Infinity");
    expect(fmtHours(-Infinity)).toBe("-Infinity");
  });

  it("round-trips the values memberUtilisation actually produces", () => {
    const r = memberUtilisation(37, 37.5);
    expect(fmtHours(r.allocatedHours!)).toBe("13.9");
    expect(fmtHours(r.freeHours!)).toBe("23.6");
    expect(fmtHours(memberUtilisation(100, 40).freeHours!)).toBe("0");
  });
});

import { describe, it, expect } from "vitest";
import { computeEvm, type EvmInput } from "./evm";

const base: EvmInput = {
  planned_amount: 100_000,
  completion_pct: 50,
  committed_amount: 10_000,
  actual_amount: 60_000,
  as_of_date: "2026-06-01",
};

describe("computeEvm: forecast at completion (B3)", () => {
  it("computes both EACs; cpi is the default method", () => {
    const r = computeEvm({ ...base, estimate_to_complete: 25_000 });
    // CPI = EV / AC = 50,000 / 60,000
    expect(r.eac_cpi).toBeCloseTo(120_000, 0);
    // bottom-up = incurred + committed + to-finish
    expect(r.eac_bottom_up).toBe(60_000 + 10_000 + 25_000);
    expect(r.forecast_method).toBe("cpi");
    expect(r.eac).toBeCloseTo(120_000, 0);
    expect(r.etc).toBeCloseTo(60_000, 0);
    expect(r.vac).toBeCloseTo(-20_000, 0);
  });

  it("bottom_up method makes eac, etc and vac follow the bottom-up figure", () => {
    const r = computeEvm({ ...base, estimate_to_complete: 25_000, forecast_method: "bottom_up" });
    expect(r.eac).toBe(95_000);
    expect(r.etc).toBe(35_000); // committed + to-finish: what is still to spend
    expect(r.vac).toBe(5_000);
    expect(r.eac_cpi).toBeCloseTo(120_000, 0); // the other forecast is still reported
  });

  it("never double counts committed: actual stays expenses only and committed is added once", () => {
    const withCommitted = computeEvm({ ...base, estimate_to_complete: 0, forecast_method: "bottom_up" });
    const withoutCommitted = computeEvm({
      ...base,
      committed_amount: 0,
      estimate_to_complete: 0,
      forecast_method: "bottom_up",
    });
    expect(withCommitted.ac).toBe(60_000);
    expect(withCommitted.committed).toBe(10_000);
    expect(withCommitted.eac).toBe(70_000);
    expect((withCommitted.eac as number) - (withoutCommitted.eac as number)).toBe(10_000);
  });

  it("no estimate: bottom-up is null, and the bottom_up method gives a null eac instead of falling back to cpi", () => {
    const r = computeEvm({ ...base, forecast_method: "bottom_up" });
    expect(r.estimate_to_complete).toBeNull();
    expect(r.eac_bottom_up).toBeNull();
    expect(r.eac).toBeNull();
    expect(r.etc).toBeNull();
    expect(r.vac).toBeNull();
    expect(r.eac_cpi).not.toBeNull();
  });

  it("F5: bottom-up uses open commitments (committed_open) when set, so an invoiced commitment is counted once", () => {
    // 10,000 was committed; 4,000 has been invoiced and is already in the 60,000 of expenses.
    const r = computeEvm({ ...base, estimate_to_complete: 25_000, forecast_method: "bottom_up", committed_open: 6_000 });
    expect(r.committed).toBe(10_000); // the raw figure is still reported
    expect(r.committed_open).toBe(6_000);
    expect(r.eac_bottom_up).toBe(60_000 + 6_000 + 25_000);
    expect(r.eac).toBe(91_000);
    expect(r.etc).toBe(31_000);
  });

  it("F5: committed_open null falls back to committed_amount; zero is a real value", () => {
    const fallback = computeEvm({ ...base, estimate_to_complete: 25_000, committed_open: null });
    expect(fallback.committed_open).toBe(10_000);
    expect(fallback.eac_bottom_up).toBe(95_000);
    const zero = computeEvm({ ...base, estimate_to_complete: 25_000, committed_open: 0 });
    expect(zero.eac_bottom_up).toBe(85_000);
  });

  it("F5: the cpi forecast ignores committed_open", () => {
    const a = computeEvm({ ...base, committed_open: 0 });
    const b = computeEvm({ ...base, committed_open: 9_000 });
    expect(a.eac_cpi).toBe(b.eac_cpi);
  });

  it("a zero estimate is an estimate, not a missing one", () => {
    const r = computeEvm({ ...base, estimate_to_complete: 0 });
    expect(r.eac_bottom_up).toBe(70_000);
  });

  it("ignores a negative or non-numeric estimate", () => {
    expect(computeEvm({ ...base, estimate_to_complete: -5 }).eac_bottom_up).toBeNull();
    expect(computeEvm({ ...base, estimate_to_complete: Number.NaN }).eac_bottom_up).toBeNull();
  });

  it("the cpi forecast stays null when nothing is spent, while bottom-up still works", () => {
    const r = computeEvm({ ...base, actual_amount: 0, estimate_to_complete: 40_000 });
    expect(r.eac_cpi).toBeNull();
    expect(r.eac).toBeNull();
    expect(r.eac_bottom_up).toBe(50_000);
  });

  it("an unknown method falls back to cpi", () => {
    expect(computeEvm({ ...base, forecast_method: "nope" as never }).forecast_method).toBe("cpi");
  });
});

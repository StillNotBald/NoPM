import { describe, it, expect, vi } from "vitest";
import { computeEvm } from "./evm";

const base = { planned_amount: 100_000, committed_amount: 60_000, completion_pct: 50, actual_amount: 45_000 };

describe("computeEvm — completion-only (fallback) mode", () => {
  it("derives BAC/EV/AC and a healthy CPI; SPI is 1.00 when no baseline dates", () => {
    const r = computeEvm(base);
    expect(r.bac).toBe(100_000);
    expect(r.ev).toBe(50_000);
    expect(r.ac).toBe(45_000);
    expect(r.pv).toBe(50_000); // PV == EV in fallback mode
    expect(r.cv).toBe(5_000);
    expect(r.sv).toBe(0);
    expect(r.cpi).toBeCloseTo(1.111, 2);
    expect(r.spi).toBe(1); // schedule-neutral
    expect(r.eac).toBeCloseTo(90_000, 0);
    expect(r.etc).toBeCloseTo(45_000, 0);
    expect(r.vac).toBeCloseTo(10_000, 0);
  });

  it("flags an over-budget project (CPI < 1, negative VAC)", () => {
    const r = computeEvm({ ...base, actual_amount: 60_000 });
    expect(r.cpi).toBeCloseTo(0.833, 2);
    expect(r.eac).toBeCloseTo(120_000, 0);
    expect(r.vac).toBeCloseTo(-20_000, 0);
  });
});

describe("computeEvm — schedule-aware SPI (the part the review under-credited)", () => {
  it("SPI < 1 when behind baseline schedule", () => {
    // 100% of the baseline window elapsed but only 50% complete → SPI 0.5
    const r = computeEvm({
      ...base,
      baseline_start_date: "2025-01-01",
      baseline_target_date: "2025-12-31",
      as_of_date: "2025-12-31",
    });
    expect(r.pv).toBe(100_000);
    expect(r.spi).toBeCloseTo(0.5, 5);
    expect(r.sv).toBe(-50_000);
  });

  it("SPI ≈ 1 when completion matches elapsed schedule", () => {
    // 10-day baseline, 5 days elapsed (50%), 50% complete → on schedule
    const r = computeEvm({
      ...base,
      baseline_start_date: "2025-01-01",
      baseline_target_date: "2025-01-11",
      as_of_date: "2025-01-06",
    });
    expect(r.pv).toBe(50_000);
    expect(r.spi).toBe(1);
  });

  it("falls back to schedule-neutral when the baseline is degenerate (start == target)", () => {
    const r = computeEvm({
      ...base,
      baseline_start_date: "2025-01-01",
      baseline_target_date: "2025-01-01",
      as_of_date: "2025-06-01",
    });
    expect(r.pv).toBe(r.ev); // fallback
    expect(r.spi).toBe(1);
  });
});

describe("computeEvm — divide-by-zero + clamping guards", () => {
  it("returns null indices (not Infinity/NaN) when AC = 0 and PV = 0", () => {
    const r = computeEvm({ planned_amount: 100_000, committed_amount: 0, completion_pct: 0, actual_amount: 0 });
    expect(r.cpi).toBeNull();
    expect(r.spi).toBeNull();
    expect(r.eac).toBeNull();
    expect(r.etc).toBeNull();
    expect(r.vac).toBeNull();
  });

  it("clamps completion_pct into 0–100", () => {
    expect(computeEvm({ ...base, completion_pct: 150 }).ev).toBe(100_000); // clamped to 100
    expect(computeEvm({ ...base, completion_pct: -10 }).ev).toBe(0); // clamped to 0
  });

  it("coerces non-finite inputs to 0 rather than propagating NaN", () => {
    const r = computeEvm({ planned_amount: NaN, committed_amount: NaN, completion_pct: NaN, actual_amount: NaN });
    expect(r.bac).toBe(0);
    expect(r.ev).toBe(0);
    expect(r.ac).toBe(0);
  });
});

describe("computeEvm — as-of fallback uses the workspace zone, not UTC", () => {
  it("just after local midnight (UTC+8) the elapsed days count the local date", () => {
    vi.useFakeTimers();
    try {
      // 2025-01-05T16:30Z is 00:30 on 6 Jan in Kuala Lumpur (UTC alone says 5 Jan).
      vi.setSystemTime(new Date("2025-01-05T16:30:00Z"));
      const fallback = computeEvm({ ...base, baseline_start_date: "2025-01-01", baseline_target_date: "2025-01-11" });
      const explicit = computeEvm({
        ...base,
        baseline_start_date: "2025-01-01",
        baseline_target_date: "2025-01-11",
        as_of_date: "2025-01-06",
      });
      expect(fallback.pv).toBe(explicit.pv);
    } finally {
      vi.useRealTimers();
    }
  });
});

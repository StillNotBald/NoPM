import { describe, it, expect } from "vitest";
import {
  preferencesConfigSchema,
  decodePreferencesConfig,
  emptyPreferencesConfig,
  isConfigWithinSizeCap,
  configSizeBytes,
  MAX_CONFIG_BYTES,
} from "./_schema";

describe("preferencesConfigSchema — whitelist (L-39)", () => {
  it("accepts every documented key", () => {
    const parsed = preferencesConfigSchema.safeParse({
      columns: { tasks: ["name", "status_type"] },
      groupBy: { tasks: "priority", risks: null },
      density: "compact",
      dateDisplay: "relative",
      defaultLanding: "/dashboard",
      onboarding: { step: 2, dismissed: false },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an empty object (no preferences set yet)", () => {
    expect(preferencesConfigSchema.safeParse({}).success).toBe(true);
  });

  it("strips unknown top-level keys rather than rejecting the whole payload", () => {
    const parsed = preferencesConfigSchema.parse({
      density: "compact",
      // Not in the whitelist — must be silently dropped, not stored.
      favoriteColor: "blue",
      isAdminOverride: true,
    });
    expect(parsed).toEqual({ density: "compact" });
    expect(parsed).not.toHaveProperty("favoriteColor");
    expect(parsed).not.toHaveProperty("isAdminOverride");
  });

  it("rejects a density value outside the closed appearance registry", () => {
    expect(preferencesConfigSchema.safeParse({ density: "ultra-compact" }).success).toBe(false);
  });

  it("rejects a dateDisplay value outside the closed appearance registry", () => {
    expect(preferencesConfigSchema.safeParse({ dateDisplay: "fuzzy" }).success).toBe(false);
  });

  it("rejects a register key in columns/groupBy that isn't lowercase letters/underscores", () => {
    expect(preferencesConfigSchema.safeParse({ columns: { "Tasks!": ["name"] } }).success).toBe(false);
    expect(preferencesConfigSchema.safeParse({ groupBy: { "123": "priority" } }).success).toBe(false);
  });

  it("rejects an empty columns array for a register (at least one column must stay visible)", () => {
    expect(preferencesConfigSchema.safeParse({ columns: { tasks: [] } }).success).toBe(false);
  });

  it("groupBy accepts null per register (explicit ungrouped, not just absence)", () => {
    const parsed = preferencesConfigSchema.safeParse({ groupBy: { tasks: null } });
    expect(parsed.success).toBe(true);
  });

  it("rejects a non-object payload", () => {
    expect(preferencesConfigSchema.safeParse("not-an-object").success).toBe(false);
    expect(preferencesConfigSchema.safeParse(null).success).toBe(false);
    expect(preferencesConfigSchema.safeParse([1, 2, 3]).success).toBe(false);
  });
});

describe("preferencesConfigSchema — onboarding key (L-45, first-run wizard, D7)", () => {
  it("accepts the full onboarding shape locked by D7", () => {
    const parsed = preferencesConfigSchema.safeParse({
      onboarding: { step: 2, dismissed: false, completedAt: "2026-08-15T00:00:00.000Z" },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a partial onboarding object (only step set, still mid-flow)", () => {
    const parsed = preferencesConfigSchema.safeParse({ onboarding: { step: 3 } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.onboarding).toEqual({ step: 3 });
  });

  it("accepts dismissed-only (the X control persists just this)", () => {
    const parsed = preferencesConfigSchema.safeParse({ onboarding: { dismissed: true } });
    expect(parsed.success).toBe(true);
  });

  it("strips unknown keys NESTED inside onboarding, not just at the top level", () => {
    const parsed = preferencesConfigSchema.parse({
      onboarding: { step: 1, notAWizardField: "sneaky", completedAt: undefined },
    });
    expect(parsed.onboarding).toEqual({ step: 1 });
    expect(parsed.onboarding).not.toHaveProperty("notAWizardField");
  });

  it("rejects a step outside 1..4", () => {
    expect(preferencesConfigSchema.safeParse({ onboarding: { step: 0 } }).success).toBe(false);
    expect(preferencesConfigSchema.safeParse({ onboarding: { step: 5 } }).success).toBe(false);
  });

  it("rejects a non-integer step", () => {
    expect(preferencesConfigSchema.safeParse({ onboarding: { step: 2.5 } }).success).toBe(false);
  });

  it("rejects a completedAt that isn't a valid ISO datetime string", () => {
    expect(
      preferencesConfigSchema.safeParse({ onboarding: { completedAt: "not-a-date" } }).success,
    ).toBe(false);
  });

  it("rejects a non-boolean dismissed", () => {
    expect(preferencesConfigSchema.safeParse({ onboarding: { dismissed: "yes" } }).success).toBe(
      false,
    );
  });

  it("an onboarding value that isn't an object is rejected, not silently dropped", () => {
    expect(preferencesConfigSchema.safeParse({ onboarding: "dismissed" }).success).toBe(false);
  });

  it("a config with only onboarding round-trips without inventing the other keys", () => {
    const parsed = preferencesConfigSchema.parse({ onboarding: { dismissed: true } });
    expect(parsed).toEqual({ onboarding: { dismissed: true } });
  });
});

describe("decodePreferencesConfig — read-time defensive decode (never throws, never blanks the page)", () => {
  it("returns the empty config for null/undefined (no row yet)", () => {
    expect(decodePreferencesConfig(null)).toEqual(emptyPreferencesConfig());
    expect(decodePreferencesConfig(undefined)).toEqual(emptyPreferencesConfig());
  });

  it("returns the empty config for a corrupt/unrecognised shape rather than throwing", () => {
    expect(() => decodePreferencesConfig("garbage")).not.toThrow();
    expect(decodePreferencesConfig("garbage")).toEqual(emptyPreferencesConfig());
    expect(decodePreferencesConfig(42)).toEqual(emptyPreferencesConfig());
    expect(decodePreferencesConfig({ density: "not-real" })).toEqual(emptyPreferencesConfig());
  });

  it("round-trips a valid config", () => {
    const config = { density: "compact" as const, dateDisplay: "relative" as const };
    expect(decodePreferencesConfig(config)).toEqual(config);
  });
});

describe("size cap (register: 'size-capped')", () => {
  it("a small config is within the cap", () => {
    expect(isConfigWithinSizeCap({ density: "compact" })).toBe(true);
  });

  it("computes byte length via JSON.stringify", () => {
    const config = { defaultLanding: "/dashboard" };
    expect(configSizeBytes(config)).toBe(JSON.stringify(config).length);
  });

  it("a config padded past MAX_CONFIG_BYTES fails the cap", () => {
    // columnsSchema caps a SINGLE register's array at 50 entries, so one
    // register alone can't cross a 10KB cap — pad across many register keys
    // instead (no cap on register COUNT, only on shape per key).
    const columns: Record<string, string[]> = {};
    for (let r = 0; r < 40; r++) {
      columns[`register_${r}`] = Array.from({ length: 50 }, (_, i) =>
        `column_name_padding_${i}`.padEnd(60, "x"),
      );
    }
    const bloated = { columns };
    // Sanity: this fixture really does exceed the cap before asserting on it.
    expect(configSizeBytes(bloated)).toBeGreaterThan(MAX_CONFIG_BYTES);
    expect(isConfigWithinSizeCap(bloated)).toBe(false);
  });

  it("the cap is evaluated against the SANITIZED (post-strip) config, not the raw body", () => {
    // A caller can't dodge the cap by padding the body with unknown keys —
    // those are stripped by the schema before the size check ever runs.
    const rawBody = { density: "compact", junk: "x".repeat(MAX_CONFIG_BYTES) };
    const sanitized = preferencesConfigSchema.parse(rawBody);
    expect(isConfigWithinSizeCap(sanitized)).toBe(true);
    expect(isConfigWithinSizeCap(rawBody)).toBe(false); // raw body alone WOULD exceed it
  });
});

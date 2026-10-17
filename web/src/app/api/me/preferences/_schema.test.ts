import { describe, it, expect } from "vitest";
import {
  preferencesConfigSchema,
  decodePreferencesConfig,
  emptyPreferencesConfig,
  isConfigWithinSizeCap,
  configSizeBytes,
  mergePreferencesConfig,
  MAX_CONFIG_BYTES,
  type PreferencesConfig,
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
      tour: { dismissed: false, visited: ["trust-center"] },
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

describe("preferencesConfigSchema — tour key (L-50, governance tour, R-77)", () => {
  it("accepts the full tour shape (dismissed + visited)", () => {
    const parsed = preferencesConfigSchema.safeParse({
      tour: { dismissed: false, visited: ["trust-center", "review-queue"] },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts dismissed-only (the X control persists just this)", () => {
    const parsed = preferencesConfigSchema.safeParse({ tour: { dismissed: true } });
    expect(parsed.success).toBe(true);
  });

  it("accepts visited-only, no dismissed yet", () => {
    const parsed = preferencesConfigSchema.safeParse({ tour: { visited: ["sprints"] } });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.tour).toEqual({ visited: ["sprints"] });
  });

  it("accepts an empty tour object", () => {
    expect(preferencesConfigSchema.safeParse({ tour: {} }).success).toBe(true);
  });

  it("strips unknown keys NESTED inside tour, not just at the top level", () => {
    const parsed = preferencesConfigSchema.parse({
      tour: { dismissed: true, notATourField: "sneaky" },
    });
    expect(parsed.tour).toEqual({ dismissed: true });
    expect(parsed.tour).not.toHaveProperty("notATourField");
  });

  it("caps visited at 12 item ids", () => {
    const visited = Array.from({ length: 12 }, (_, i) => `item-${i}`);
    expect(preferencesConfigSchema.safeParse({ tour: { visited } }).success).toBe(true);
    const tooMany = [...visited, "item-12"];
    expect(preferencesConfigSchema.safeParse({ tour: { visited: tooMany } }).success).toBe(false);
  });

  it("rejects a non-boolean dismissed", () => {
    expect(preferencesConfigSchema.safeParse({ tour: { dismissed: "yes" } }).success).toBe(false);
  });

  it("rejects a non-array visited", () => {
    expect(preferencesConfigSchema.safeParse({ tour: { visited: "trust-center" } }).success).toBe(
      false,
    );
  });

  it("rejects a tour value that isn't an object", () => {
    expect(preferencesConfigSchema.safeParse({ tour: "dismissed" }).success).toBe(false);
  });

  it("a config with only tour round-trips without inventing the other keys", () => {
    const parsed = preferencesConfigSchema.parse({ tour: { dismissed: true } });
    expect(parsed).toEqual({ tour: { dismissed: true } });
  });

  it("tour and onboarding coexist independently", () => {
    const parsed = preferencesConfigSchema.safeParse({
      onboarding: { step: 2 },
      tour: { dismissed: true },
    });
    expect(parsed.success).toBe(true);
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

describe("mergePreferencesConfig — merge-upsert semantics (stability fix: PUT no longer clobbers other keys)", () => {
  it("preserves an untouched top-level key not present in the incoming partial", () => {
    const existing: PreferencesConfig = { density: "compact", defaultLanding: "/dashboard" };
    const incoming: PreferencesConfig = { tour: { dismissed: true } };
    const merged = mergePreferencesConfig(existing, incoming);
    expect(merged).toEqual({
      density: "compact",
      defaultLanding: "/dashboard",
      tour: { dismissed: true },
    });
  });

  it("the exact regression this fixes: dismissing the governance tour must not wipe columns/groupBy/density saved earlier", () => {
    const existing: PreferencesConfig = {
      columns: { tasks: ["name", "status_type"] },
      groupBy: { tasks: "priority" },
      density: "compact",
      dateDisplay: "relative",
      defaultLanding: "/tasks",
      onboarding: { dismissed: true },
    };
    const incoming: PreferencesConfig = { tour: { dismissed: true } };
    const merged = mergePreferencesConfig(existing, incoming);
    expect(merged).toEqual({ ...existing, tour: { dismissed: true } });
  });

  it("an incoming top-level scalar/object key overrides the same key on existing", () => {
    const existing: PreferencesConfig = { density: "compact", onboarding: { step: 2 } };
    const incoming: PreferencesConfig = { density: "comfortable", onboarding: { step: 3 } };
    const merged = mergePreferencesConfig(existing, incoming);
    expect(merged.density).toBe("comfortable");
    // onboarding is replaced whole, not deep-merged — incoming already sends
    // its own complete object for the key it owns (see the docstring).
    expect(merged.onboarding).toEqual({ step: 3 });
  });

  it("merges columns per-register: incoming register overrides, other registers are preserved", () => {
    const existing: PreferencesConfig = {
      columns: { tasks: ["name", "status_type"], risks: ["title", "severity"] },
    };
    const incoming: PreferencesConfig = { columns: { tasks: ["name"] } };
    const merged = mergePreferencesConfig(existing, incoming);
    expect(merged.columns).toEqual({ tasks: ["name"], risks: ["title", "severity"] });
  });

  it("merges groupBy per-register: incoming register overrides, other registers are preserved", () => {
    const existing: PreferencesConfig = { groupBy: { tasks: "priority", risks: "severity" } };
    const incoming: PreferencesConfig = { groupBy: { tasks: null } };
    const merged = mergePreferencesConfig(existing, incoming);
    expect(merged.groupBy).toEqual({ tasks: null, risks: "severity" });
  });

  it("columns/groupBy merge adds a new register key alongside existing ones", () => {
    const existing: PreferencesConfig = { columns: { tasks: ["name"] } };
    const incoming: PreferencesConfig = { columns: { risks: ["title"] } };
    const merged = mergePreferencesConfig(existing, incoming);
    expect(merged.columns).toEqual({ tasks: ["name"], risks: ["title"] });
  });

  it("merging with an empty existing config is the identity of incoming", () => {
    const incoming: PreferencesConfig = { density: "compact", tour: { dismissed: true } };
    expect(mergePreferencesConfig(emptyPreferencesConfig(), incoming)).toEqual(incoming);
  });

  it("merging with an empty incoming config is the identity of existing", () => {
    const existing: PreferencesConfig = { density: "compact", tour: { dismissed: true } };
    expect(mergePreferencesConfig(existing, emptyPreferencesConfig())).toEqual(existing);
  });

  it("merging two empty configs yields an empty config", () => {
    expect(mergePreferencesConfig(emptyPreferencesConfig(), emptyPreferencesConfig())).toEqual({});
  });

  it("the merged result always still passes preferencesConfigSchema", () => {
    const existing: PreferencesConfig = {
      columns: { tasks: ["name"] },
      groupBy: { tasks: "priority" },
      density: "compact",
      dateDisplay: "relative",
      defaultLanding: "/tasks",
      onboarding: { dismissed: true },
      tour: { visited: ["trust-center"] },
    };
    const incoming: PreferencesConfig = {
      columns: { risks: ["title"] },
      tour: { dismissed: true, visited: ["trust-center", "sprints"] },
    };
    const merged = mergePreferencesConfig(existing, incoming);
    expect(preferencesConfigSchema.safeParse(merged).success).toBe(true);
  });
});

describe("preferencesConfigSchema — nav / hints / start keys (R-78, progressive-disclosure onboarding)", () => {
  it("accepts nav.mode essentials|all and rejects anything else", () => {
    expect(preferencesConfigSchema.safeParse({ nav: { mode: "essentials" } }).success).toBe(true);
    expect(preferencesConfigSchema.safeParse({ nav: { mode: "all" } }).success).toBe(true);
    expect(preferencesConfigSchema.safeParse({ nav: { mode: "compact" } }).success).toBe(false);
  });

  it("accepts hints.dismissed up to 40 ids and rejects 41", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `page-${i}`);
    expect(preferencesConfigSchema.safeParse({ hints: { dismissed: ids(40) } }).success).toBe(true);
    expect(preferencesConfigSchema.safeParse({ hints: { dismissed: ids(41) } }).success).toBe(false);
  });

  it("accepts start.dismissed + start.visited (max 12) and strips unknown nested keys", () => {
    const parsed = preferencesConfigSchema.safeParse({
      start: { dismissed: true, visited: ["trust"], bogus: 1 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.start).toEqual({ dismissed: true, visited: ["trust"] });
    expect(
      preferencesConfigSchema.safeParse({ start: { visited: Array.from({ length: 13 }, (_, i) => `s${i}`) } })
        .success,
    ).toBe(false);
  });

  it("the three keys coexist with every other key and survive a merge untouched", () => {
    const merged = mergePreferencesConfig(
      { columns: { tasks: ["name"] }, nav: { mode: "all" } },
      { hints: { dismissed: ["risks"] }, start: { visited: ["trust"] } },
    );
    expect(merged).toEqual({
      columns: { tasks: ["name"] },
      nav: { mode: "all" },
      hints: { dismissed: ["risks"] },
      start: { visited: ["trust"] },
    });
    expect(preferencesConfigSchema.safeParse(merged).success).toBe(true);
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

describe("preferencesConfigSchema — nav.shortcuts (bottom-bar persistence)", () => {
  it("accepts in-app paths and rejects non-paths / oversize lists", () => {
    expect(preferencesConfigSchema.safeParse({ nav: { shortcuts: ["/risks", "/change-control"] } }).success).toBe(true);
    expect(preferencesConfigSchema.safeParse({ nav: { shortcuts: ["https://evil.example"] } }).success).toBe(false);
    expect(preferencesConfigSchema.safeParse({ nav: { shortcuts: ["risks"] } }).success).toBe(false);
    expect(
      preferencesConfigSchema.safeParse({ nav: { shortcuts: Array.from({ length: 9 }, () => "/risks") } }).success,
    ).toBe(false);
  });

  it("merges nav one level deep so mode and shortcuts do not clobber each other", () => {
    const merged = mergePreferencesConfig(
      { nav: { shortcuts: ["/risks"] } },
      { nav: { mode: "essentials" } },
    );
    expect(merged.nav).toEqual({ mode: "essentials", shortcuts: ["/risks"] });
    const merged2 = mergePreferencesConfig(merged, { nav: { shortcuts: ["/issues"] } });
    expect(merged2.nav).toEqual({ mode: "essentials", shortcuts: ["/issues"] });
  });
});

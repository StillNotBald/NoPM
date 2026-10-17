import { describe, expect, it } from "vitest";
import { shouldShowTour } from "./tour";
import {
  isSeededReady,
  pickOnboardingConfig,
  resolveSeededConfig,
  shouldPersist,
  type PrefsSeed,
} from "./seed";

const seedDismissed: PrefsSeed = { config: { tour: { dismissed: true } }, demo: false };
const seedFresh: PrefsSeed = { config: {}, demo: false };

describe("pickOnboardingConfig", () => {
  it("keeps only the onboarding keys", () => {
    const out = pickOnboardingConfig({
      density: "compact",
      columns: { tasks: ["name"] },
      tour: { dismissed: true },
      start: { visited: ["audit"] },
      hints: { dismissed: ["risks"] },
      onboarding: { step: 2 },
    });
    expect(out).toEqual({
      tour: { dismissed: true },
      start: { visited: ["audit"] },
      hints: { dismissed: ["risks"] },
      onboarding: { step: 2 },
    });
  });
  it("is empty for a missing config (the demo login, a new account)", () => {
    expect(pickOnboardingConfig(null)).toEqual({});
    expect(pickOnboardingConfig(undefined)).toEqual({});
    expect(pickOnboardingConfig({})).toEqual({});
  });
});

describe("resolveSeededConfig: the first render comes from the server", () => {
  it("renders from the seed while the client store is still loading (no empty first paint)", () => {
    const cfg = resolveSeededConfig({ seed: seedDismissed, storeReady: false, storeConfig: {}, local: {} });
    expect(cfg.tour?.dismissed).toBe(true);
    // a dismissed tour stays hidden from the very first render: nothing pops in later
    expect(shouldShowTour(cfg.tour)).toBe(false);
  });

  it("shows a fresh viewer's tour from the first render too", () => {
    const cfg = resolveSeededConfig({ seed: seedFresh, storeReady: false, storeConfig: {}, local: {} });
    expect(shouldShowTour(cfg.tour)).toBe(true);
  });

  it("hands over to the store once it has loaded", () => {
    const cfg = resolveSeededConfig({
      seed: seedFresh,
      storeReady: true,
      storeConfig: { tour: { dismissed: true } },
      local: {},
    });
    expect(cfg.tour?.dismissed).toBe(true);
  });

  it("lets the viewer's own click win over a store that loads with the pre-click state", () => {
    const afterClick = { tour: { dismissed: true } };
    const cfg = resolveSeededConfig({
      seed: seedFresh,
      storeReady: true,
      storeConfig: { tour: { dismissed: false } }, // GET landed after the click, before the PUT
      local: afterClick,
    });
    expect(cfg.tour?.dismissed).toBe(true);
  });

  it("without a seed it falls back to the store's config (the old wait-for-ready behaviour)", () => {
    const cfg = resolveSeededConfig({ seed: null, storeReady: false, storeConfig: {}, local: {} });
    expect(cfg).toEqual({});
  });
});

describe("isSeededReady", () => {
  it("is ready when either the server knew or the store loaded", () => {
    expect(isSeededReady({ seed: seedFresh, storeReady: false })).toBe(true);
    expect(isSeededReady({ seed: null, storeReady: true })).toBe(true);
    expect(isSeededReady({ seed: undefined, storeReady: false })).toBe(false);
    expect(isSeededReady({ seed: null, storeReady: false })).toBe(false);
  });
});

describe("shouldPersist: the shared demo login is never written", () => {
  it("skips the PUT before the store has loaded when the server said demo", () => {
    expect(shouldPersist({ seed: { config: {}, demo: true }, storeReady: false, storeDemo: false })).toBe(false);
  });
  it("persists for a real viewer before the store has loaded", () => {
    expect(shouldPersist({ seed: seedFresh, storeReady: false, storeDemo: false })).toBe(true);
  });
  it("defers to the store once it has loaded", () => {
    expect(shouldPersist({ seed: seedFresh, storeReady: true, storeDemo: true })).toBe(false);
    expect(shouldPersist({ seed: { config: {}, demo: true }, storeReady: true, storeDemo: false })).toBe(true);
  });
});

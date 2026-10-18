import { describe, it, expect } from "vitest";
import {
  clampStep,
  nextStep,
  shouldShowWizard,
  dismissedState,
  advancedState,
  completedState,
  FIRST_STEP,
  LAST_STEP,
} from "./steps";

describe("clampStep — corrupt/out-of-range persisted step falls back to FIRST_STEP", () => {
  it("passes through valid steps unchanged", () => {
    expect(clampStep(1)).toBe(1);
    expect(clampStep(2)).toBe(2);
    expect(clampStep(3)).toBe(3);
    expect(clampStep(4)).toBe(4);
  });

  it("undefined/null default to the first step", () => {
    expect(clampStep(undefined)).toBe(FIRST_STEP);
    expect(clampStep(null)).toBe(FIRST_STEP);
  });

  it("out-of-range values (0, negative, > LAST_STEP) fall back to the first step", () => {
    expect(clampStep(0)).toBe(FIRST_STEP);
    expect(clampStep(-1)).toBe(FIRST_STEP);
    expect(clampStep(5)).toBe(FIRST_STEP);
    expect(clampStep(99)).toBe(FIRST_STEP);
  });

  it("non-integer values fall back to the first step", () => {
    expect(clampStep(2.5)).toBe(FIRST_STEP);
  });
});

describe("nextStep — capped at LAST_STEP", () => {
  it("advances by one", () => {
    expect(nextStep(1)).toBe(2);
    expect(nextStep(2)).toBe(3);
    expect(nextStep(3)).toBe(4);
  });

  it("is a no-op once already on the last step", () => {
    expect(nextStep(4)).toBe(4);
  });
});

describe("shouldShowWizard — dismissal and completion are both terminal", () => {
  it("shows for a brand new user with no onboarding state yet", () => {
    expect(shouldShowWizard(undefined)).toBe(true);
  });

  it("shows when state exists but nothing terminal has happened", () => {
    expect(shouldShowWizard({ step: 2 })).toBe(true);
  });

  it("hides once dismissed", () => {
    expect(shouldShowWizard({ dismissed: true })).toBe(false);
  });

  it("hides once completed", () => {
    expect(shouldShowWizard({ completedAt: "2026-08-15T00:00:00.000Z" })).toBe(false);
  });

  it("dismissed wins even alongside an in-progress step", () => {
    expect(shouldShowWizard({ step: 3, dismissed: true })).toBe(false);
  });
});

describe("state transition helpers preserve the rest of the onboarding object", () => {
  it("dismissedState sets dismissed without disturbing an existing step", () => {
    expect(dismissedState({ step: 2 })).toEqual({ step: 2, dismissed: true });
    expect(dismissedState(undefined)).toEqual({ dismissed: true });
  });

  it("advancedState only updates step", () => {
    expect(advancedState({ dismissed: false }, 3)).toEqual({ dismissed: false, step: 3 });
  });

  it("completedState sets step to LAST_STEP and stamps completedAt", () => {
    const result = completedState({ step: 3 });
    expect(result.step).toBe(LAST_STEP);
    expect(typeof result.completedAt).toBe("string");
    expect(() => new Date(result.completedAt as string).toISOString()).not.toThrow();
  });
});

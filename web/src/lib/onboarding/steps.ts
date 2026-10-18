/**
 * First-run wizard (L-45, D7) — pure step-machine helpers, kept free of any
 * fetch/React so the resume/dismiss/advance rules are unit-testable without
 * mocking the network. The wizard component (components/onboarding/
 * first-run-wizard.tsx) is the only caller.
 *
 * Steps: 1 welcome/explain → 2 create first project → 3 create first task →
 * 4 done (links to /tasks + /tokens#connect-agent).
 *
 * Persistence shape mirrors D7 exactly — the `onboarding` key added to
 * preferencesConfigSchema (web/src/app/api/me/preferences/_schema.ts):
 *   { completedAt?: ISO string, dismissed?: boolean, step?: number }
 */

export const FIRST_STEP = 1;
export const LAST_STEP = 4;

export type OnboardingStep = 1 | 2 | 3 | 4;

export interface OnboardingState {
  completedAt?: string;
  dismissed?: boolean;
  step?: number;
}

/**
 * Clamp a persisted (or corrupt/out-of-range) step value into a valid
 * OnboardingStep. Anything outside 1..4 — including undefined, decimals, or
 * a value from a future version of the wizard with more steps — falls back
 * to the first step rather than crashing the component.
 */
export function clampStep(step: number | undefined | null): OnboardingStep {
  if (typeof step !== "number" || !Number.isInteger(step)) return FIRST_STEP;
  if (step < FIRST_STEP || step > LAST_STEP) return FIRST_STEP;
  return step as OnboardingStep;
}

/** The step after `step`, capped at LAST_STEP (no-op once on the done step). */
export function nextStep(step: OnboardingStep): OnboardingStep {
  return step >= LAST_STEP ? LAST_STEP : ((step + 1) as OnboardingStep);
}

/**
 * Whether the wizard should render at all, given whatever onboarding state
 * was read back from GET /api/me/preferences (or `undefined` for a brand
 * new user with no preferences row yet). Dismissal and completion are both
 * terminal — once either is set the wizard stays hidden even if the workspace
 * still (or again) has zero projects.
 */
export function shouldShowWizard(onboarding: OnboardingState | undefined): boolean {
  if (!onboarding) return true;
  if (onboarding.dismissed) return false;
  if (onboarding.completedAt) return false;
  return true;
}

/** New state after the user dismisses the wizard (the X control). */
export function dismissedState(onboarding: OnboardingState | undefined): OnboardingState {
  return { ...onboarding, dismissed: true };
}

/** New state after advancing past `step` (does not itself mark completion). */
export function advancedState(
  onboarding: OnboardingState | undefined,
  step: OnboardingStep,
): OnboardingState {
  return { ...onboarding, step };
}

/** New state once the final step is reached — sets both step and completedAt. */
export function completedState(onboarding: OnboardingState | undefined): OnboardingState {
  return { ...onboarding, step: LAST_STEP, completedAt: new Date().toISOString() };
}

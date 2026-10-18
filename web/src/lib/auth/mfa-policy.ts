/**
 * Decision 22 - two-step sign-in is required for admins and managers.
 *
 * A 14-day grace period starts when a person becomes an admin/manager (or at
 * the 0081 release for the ones who already are: profiles.mfa_grace_started_at).
 * After the grace the CONSOLE sends them to enrol before they use it. API
 * tokens are unaffected. The shared demo login cannot enrol, so it is exempt.
 */

export const MFA_REQUIRED_ROLES = ["admin", "manager"] as const;
export const MFA_GRACE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export type MfaRequirement = {
  /** The role needs two-step at all. */
  required: boolean;
  /** Required, not yet enrolled, still inside the grace period. */
  inGrace: boolean;
  /** ISO end of the grace period (null when not required or no clock). */
  graceEndsAt: string | null;
  /** Whole days left in the grace (0 once over; null when not applicable). */
  daysLeft: number | null;
  /** Required, not enrolled, grace over: the console must send them to enrol. */
  mustEnrol: boolean;
};

export function isMfaRequiredRole(role: string | null | undefined): boolean {
  return !!role && (MFA_REQUIRED_ROLES as readonly string[]).includes(role);
}

/**
 * @param graceStartedAt profiles.mfa_grace_started_at. A required-role person with
 *   no clock yet (migration not applied) is treated as just started: never locked out.
 */
export function evaluateMfaRequirement(input: {
  role: string | null | undefined;
  enrolled: boolean;
  graceStartedAt: string | null | undefined;
  isDemo?: boolean;
  now?: Date;
}): MfaRequirement {
  const none: MfaRequirement = { required: false, inGrace: false, graceEndsAt: null, daysLeft: null, mustEnrol: false };
  if (input.isDemo || !isMfaRequiredRole(input.role)) return none;
  if (input.enrolled) return { ...none, required: true };

  const now = input.now ?? new Date();
  const started = input.graceStartedAt ? Date.parse(input.graceStartedAt) : NaN;
  const startMs = Number.isFinite(started) ? started : now.getTime();
  const endsMs = startMs + MFA_GRACE_DAYS * DAY_MS;
  const over = now.getTime() >= endsMs;
  return {
    required: true,
    inGrace: !over,
    graceEndsAt: new Date(endsMs).toISOString(),
    daysLeft: over ? 0 : Math.ceil((endsMs - now.getTime()) / DAY_MS),
    mustEnrol: over,
  };
}

/** Console areas that need two-step once the grace is over (settings stays open so they can enrol). */
export const MFA_GATED_CONSOLE_PREFIXES = [
  "/approvals",
  "/baselines",
  "/budget",
  "/change-control",
  "/clashes",
  "/dashboard",
  "/decisions",
  "/documents",
  "/email-previews",
  "/integrations",
  "/issues",
  "/mainline",
  "/my-tasks",
  "/my-work",
  "/portfolio",
  "/projects",
  "/resources",
  "/review",
  "/risks",
  "/sprints",
  "/start",
  "/tasks",
  "/tokens",
  "/trust",
] as const;

export function isMfaGatedPath(pathname: string): boolean {
  return MFA_GATED_CONSOLE_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export const MFA_ENROL_REDIRECT = "/settings?mfa=required";

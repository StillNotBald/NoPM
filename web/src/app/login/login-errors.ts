/**
 * Messages for the `?error=<code>` the demo-login route redirects here with
 * (src/app/api/auth/demo-login/route.ts). Before this the page ignored the
 * param, so the one conversion path — "Try the live demo" — dead-ended on a
 * sign-in form with no explanation when the demo could not sign in.
 *
 * The page adds the way out (sign in manually, read the case study) next to
 * the message, so the text only says what happened.
 *
 * Unknown codes return null: nothing is shown rather than echoing URL text.
 */
const DEMO_LOGIN_ERRORS: Record<string, string> = {
  demo_unavailable:
    "The shared demo could not sign you in. Try again in a minute.",
  demo_unconfigured: "The shared demo is not set up on this deployment.",
};

export function demoLoginErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(DEMO_LOGIN_ERRORS, code) ? DEMO_LOGIN_ERRORS[code] : null;
}

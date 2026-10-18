import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { MFA_COOKIE_NAME } from "@/lib/auth/mfa";

export const runtime = "nodejs";

/**
 * Codes this route can put in `/login?error=<code>`; the login page maps each
 * to a message (src/app/login/login-errors.ts). Keep the two in step.
 *  - demo_unavailable  the demo account rejected the sign-in (e.g. during a reseed)
 *  - demo_unconfigured this deployment has no DEMO_EMAIL / DEMO_PASSWORD
 */
export type DemoLoginErrorCode = "demo_unavailable" | "demo_unconfigured";

/** A browser form post navigates with `Accept: text/html`; curl and agents don't. */
function isBrowserNavigation(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

function backToLogin(request: Request, code: DemoLoginErrorCode): Response {
  return NextResponse.redirect(new URL(`/login?error=${code}`, request.url), {
    status: 302,
  });
}

/**
 * POST /api/auth/demo-login
 *
 * One-click demo entry for cold visitors (R-53). Signs in with the
 * pre-seeded demo account using credentials stored in server-only env vars
 * (DEMO_EMAIL / DEMO_PASSWORD). Sets Supabase session cookies and redirects
 * to /dashboard.
 *
 * Failure handling: a browser (the landing page's form post) must never be
 * left on a blank page of raw JSON, so every failure for a browser navigation
 * is a 302 back to /login with an error code the page explains. Programmatic
 * callers keep the documented contract: JSON 503 when the demo is not
 * configured, 302 to /login?error=demo_unavailable when sign-in fails.
 *
 * Security notes:
 * - Credentials never leave the server; the env vars are server-only.
 * - The demo workspace is writable — acceptable for portfolio purposes.
 *   Mitigation: the seed script (npm run seed) resets demo data on demand.
 * - Rate-limiting is delegated to Supabase Auth (built-in brute-force
 *   protection on signInWithPassword).
 * - Session is audited identically to any human login (Supabase Auth logs).
 * - No service-role key is used here; anon key + signInWithPassword only.
 */
export async function POST(request: Request): Promise<Response> {
  const email = process.env.DEMO_EMAIL;
  const password = process.env.DEMO_PASSWORD;

  if (!email || !password) {
    if (isBrowserNavigation(request)) return backToLogin(request, "demo_unconfigured");
    return NextResponse.json(
      { error: "Demo account is not configured on this deployment." },
      { status: 503 },
    );
  }

  // Build a response we can attach cookies to.
  const response = NextResponse.redirect(new URL("/dashboard", request.url), {
    status: 302,
  });

  // Q-ACC-2: "sign out first". The new session cookies overwrite any earlier
  // ones; also drop a two-step proof cookie left by whoever was signed in before.
  response.cookies.set(MFA_COOKIE_NAME, "", { path: "/", maxAge: 0 });

  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return [];
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              response.cookies.set(name, value, {
                ...options,
                sameSite: "lax",
                secure: process.env.NODE_ENV === "production",
              }),
            );
          },
        },
      },
    );

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      // Redirect back to login with an error hint rather than exposing details.
      return backToLogin(request, "demo_unavailable");
    }
  } catch {
    // Client construction or the network call threw (bad/missing Supabase env,
    // unreachable auth host): same visitor-facing outcome as a rejected sign-in.
    return backToLogin(request, "demo_unavailable");
  }

  return response;
}

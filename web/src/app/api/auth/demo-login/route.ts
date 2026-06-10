import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

export const runtime = "nodejs";

/**
 * POST /api/auth/demo-login
 *
 * One-click demo entry for cold visitors (R-53). Signs in with the
 * pre-seeded demo account using credentials stored in server-only env vars
 * (DEMO_EMAIL / DEMO_PASSWORD). Sets Supabase session cookies and redirects
 * to /dashboard.
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
    return NextResponse.json(
      { error: "Demo account is not configured on this deployment." },
      { status: 503 },
    );
  }

  // Build a response we can attach cookies to.
  const response = NextResponse.redirect(new URL("/dashboard", request.url), {
    status: 302,
  });

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
    return NextResponse.redirect(
      new URL("/login?error=demo_unavailable", request.url),
      { status: 302 },
    );
  }

  return response;
}

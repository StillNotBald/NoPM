import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { buildCsp } from "@/lib/security/headers";
import { evaluateMfaRequirement, isMfaGatedPath, MFA_ENROL_REDIRECT } from "@/lib/auth/mfa-policy";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Refreshes the Supabase auth session on navigation (keeps cookies fresh)
 * AND generates a fresh per-request CSP nonce (Amendment 2026-09-07, ADR
 * 0011) — see `web/src/lib/security/headers.ts` for why the nonce has to be
 * minted here rather than in `next.config.ts`'s `headers()`.
 *
 * The nonce is forwarded to the app as the `x-nonce` REQUEST header (Server
 * Components read it via `(await headers()).get("x-nonce")` to pass to any
 * inline `<Script nonce={...}>`) and stamped directly onto the
 * `Content-Security-Policy` RESPONSE header; Next.js parses the nonce back
 * out of that response header during SSR and auto-attaches it to its own
 * framework-emitted inline scripts (RSC payload, runtime).
 *
 * `/api/**` routes are matched too (see `config.matcher` below — the CSP
 * must apply everywhere, and the "no unsafe-inline anywhere" verification
 * checks `/api/health`) but SKIP the Supabase session-refresh work: that
 * refresh exists for page navigation, API routes don't need it, and running
 * an extra `getUser()` round-trip on every API call would be a needless
 * latency regression unrelated to this change.
 */
export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isProd = process.env.NODE_ENV === "production";
  const csp = buildCsp({
    isProd,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    nonce,
  });

  // Built fresh each call (not hoisted) so it always reflects the CURRENT
  // state of `request` — in particular the Supabase cookie mutations made
  // below via `request.cookies.set(...)`, which is why this can't just be
  // one `requestHeaders` object built once up front.
  function nextWithNonce() {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", nonce);
    // Also on the request, per the documented Next.js recipe, so the nonce
    // reaches framework scripts even if proxy and render ever split runtimes.
    requestHeaders.set("Content-Security-Policy", csp);
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Metadata files (robots, sitemap, OG/Twitter images) are public, cacheable
  // and session-free: they keep the CSP but skip the getUser() refresh below,
  // same as API routes.
  const path = request.nextUrl.pathname;
  const isMetadataFile =
    path === "/robots.txt" ||
    path === "/sitemap.xml" ||
    /(^|\/)(opengraph|twitter)-image(\/|$|\.)/.test(path);
  if (path.startsWith("/api") || isMetadataFile) {
    const response = nextWithNonce();
    response.headers.set("Content-Security-Policy", csp);
    return response;
  }

  let response = nextWithNonce();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = nextWithNonce();
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

  // IMPORTANT: do not run logic between client creation and getUser().
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Decision 22: an admin/manager past the 14-day grace without two-step is sent
  // to enrol before using the console. Policy nudge, not the auth control: any
  // lookup problem lets the page render. API tokens never pass through here.
  if (user && isMfaGatedPath(path)) {
    const redirect = await mfaEnrolRedirect(request, user.id, supabase);
    if (redirect) {
      redirect.headers.set("Content-Security-Policy", csp);
      response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
      return redirect;
    }
  }

  response.headers.set("Content-Security-Policy", csp);
  return response;
}

async function mfaEnrolRedirect(
  request: NextRequest,
  userId: string,
  supabase: ReturnType<typeof createServerClient>,
): Promise<NextResponse | null> {
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role, email, mfa_grace_started_at")
      .eq("id", userId)
      .maybeSingle();
    if (!profile) return null;
    const demoEmail = process.env.DEMO_EMAIL;
    const isDemo = !!demoEmail && profile.email === demoEmail;
    // First pass without the user_mfa lookup: only admins/managers past grace can matter.
    const pre = evaluateMfaRequirement({
      role: profile.role,
      enrolled: false,
      graceStartedAt: profile.mfa_grace_started_at,
      isDemo,
    });
    if (!pre.mustEnrol) return null;
    const { data: mfa } = await createAdminClient()
      .from("user_mfa")
      .select("enabled")
      .eq("user_id", userId)
      .maybeSingle();
    if (mfa?.enabled) return null;
    return NextResponse.redirect(new URL(MFA_ENROL_REDIRECT, request.url));
  } catch {
    return null;
  }
}

export const config = {
  // Skip true static assets only (they never execute a document-level CSP);
  // everything else — pages AND /api/** — is matched so the nonce CSP
  // applies everywhere.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};

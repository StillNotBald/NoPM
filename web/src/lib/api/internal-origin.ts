/**
 * The origin the /api/mcp route sends its internal REST calls to.
 *
 * The route forwards the caller's own PAT to `<origin>/api/...`, so the origin
 * must not be something the caller can choose. `request.url` is built from the
 * Host header, which on a self-host that trusts it (any plain `next start`
 * behind a proxy that passes Host through) is attacker-controlled: pointing it
 * at another host would send the bearer token there.
 *
 * Order of trust:
 *  1. NEXT_PUBLIC_APP_URL, the operator's own configured app URL (already
 *     required for feed links, CSRF origin checks and the Docker build).
 *  2. On Vercel (`VERCEL` is set): the request's own origin. Vercel only routes
 *     a request to this project for a hostname the project owns, so Host is
 *     platform-validated there.
 *  3. Outside production (dev, tests): the request's own origin.
 *  4. Otherwise: null. The caller must refuse; trusting Host is not an option.
 */
export function resolveInternalOrigin(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const configured = env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // A malformed value is treated as unset, below.
    }
  }
  const onVercel = !!env.VERCEL && env.VERCEL !== "0";
  if (onVercel || env.NODE_ENV !== "production") return new URL(request.url).origin;
  return null;
}

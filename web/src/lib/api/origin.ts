import { ScopeError } from "@/lib/api/errors";

/**
 * Origin check for cookie-authenticated (session) mutations.
 *
 * A browser attaches the session cookie to ANY request aimed at this site,
 * including one a page on another origin makes (a form post, or a `fetch` with
 * `Content-Type: text/plain` that needs no CORS preflight), so a session-backed
 * write has to say where it came from. Browsers add an `Origin` header to every
 * cross-origin POST / PUT / PATCH / DELETE and page scripts cannot change it:
 * when it is present and names some other site, the request is refused (403
 * `bad_origin`).
 *
 * Accepted origins: this request's own host (the `Host` header, the first
 * `X-Forwarded-Host` entry a trusted proxy sets, or the URL the runtime parsed)
 * and the host of NEXT_PUBLIC_APP_URL. A foreign page can set none of those
 * headers on a browser request, so honouring them opens nothing.
 *
 * Not checked: a request with NO `Origin` (curl, scripts and server-side
 * callers that carry a cookie send none, and a browser omits it only on a plain
 * same-origin GET), safe methods, and Bearer-token requests (a token is not
 * ambient credentials; the caller decides which actor types to pass here).
 */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const BAD_ORIGIN_MESSAGE = "Cross-origin request refused: this call must come from the app itself";

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Every host this request may legitimately be addressed to. */
function ownHosts(request: Request, env: Record<string, string | undefined>): Set<string> {
  const hosts = new Set<string>();
  const add = (h: string | null) => {
    if (h) hosts.add(h);
  };
  add(request.headers.get("host")?.trim().toLowerCase() || null);
  add(request.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase() || null);
  add(hostOf(request.url));
  add(hostOf(env.NEXT_PUBLIC_APP_URL));
  return hosts;
}

/**
 * Throws 403 `bad_origin` for a mutating request whose `Origin` names another
 * site. A no-op for safe methods and for requests without an `Origin`.
 */
export function assertSameOrigin(request: Request, env: Record<string, string | undefined> = process.env): void {
  if (!MUTATING_METHODS.has(request.method.toUpperCase())) return;
  const origin = request.headers.get("origin");
  if (origin === null) return;

  // "null" (sandboxed frame, privacy redirect) and anything unparseable never match.
  const originHost = origin === "null" ? null : hostOf(origin);
  if (originHost && ownHosts(request, env).has(originHost)) return;
  throw new ScopeError(BAD_ORIGIN_MESSAGE, "bad_origin");
}

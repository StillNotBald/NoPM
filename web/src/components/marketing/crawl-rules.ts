/**
 * What crawlers may and may not fetch, kept out of `app/robots.ts` because a
 * metadata route file must export only its default function.
 *
 * CONSOLE_ROUTES is every folder directly under `src/app/(console)` (a route
 * group adds no URL segment). crawl-rules.test.ts walks that directory and
 * fails when a console route is missing here, so a new console page cannot
 * ship crawlable by accident. Disallow is a crawl hint, not access control:
 * each of these is behind the sign-in redirect regardless.
 */
export const CONSOLE_ROUTES = [
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
  "/settings",
  "/sprints",
  "/start",
  "/tasks",
  "/tokens",
  "/trust",
] as const;

/**
 * The public pages, plus the two machine-readable surfaces the landing links to
 * (an agent-operable product wants those found). Where Allow and Disallow both
 * match, the longer rule wins, so `/api/openapi.json` stays crawlable under the
 * broader `/api/` Disallow.
 */
export const CRAWL_ALLOW = ["/", "/llms.txt", "/api/openapi.json"] as const;

export const CRAWL_DISALLOW = [
  "/api/",
  // Invite links carry a secret token in the path.
  "/invite/",
  ...CONSOLE_ROUTES,
  // /login is deliberately absent: it is `noindex` in its own metadata, and a
  // crawler blocked here could never read that tag.
] as const;

export const PUBLIC_PAGES = ["/", "/case-study"] as const;

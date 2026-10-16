import { randomBytes } from "node:crypto";
import { hashToken } from "@/lib/auth/tokens";
import type { Actor } from "@/lib/auth/guard";

/**
 * Calendar-feed credentials. Unlike a PAT, a feed token travels inside a URL
 * that calendar apps poll, so it is shaped for that use: a distinct `npc_`
 * family (never confusable with an `npm_` PAT or an `npi_` invite) with 32
 * random bytes, i.e. 256 bits, rather than the 192 bits generateToken() uses.
 */
export const FEED_TOKEN_PREFIX = "npc_";
const FEED_TOKEN_PATTERN = /^npc_[A-Za-z0-9_-]{43}$/;
const ICS_SUFFIX = ".ics";

/** The raw token is returned once, in the feed URL. Only its SHA-256 is stored. */
export function generateFeedToken(): { raw: string; hash: string } {
  const raw = `${FEED_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashToken(raw) };
}

/**
 * Turn the last path segment of a feed URL into a raw token. Calendar clients
 * expect a `.ics` suffix, so it is stripped when present. Anything that cannot
 * be a feed token returns null without touching the database.
 */
export function parseFeedSegment(segment: string): string | null {
  const raw = segment.endsWith(ICS_SUFFIX) ? segment.slice(0, -ICS_SUFFIX.length) : segment;
  return FEED_TOKEN_PATTERN.test(raw) ? raw : null;
}

/**
 * The human a feed belongs to. A session user owns feeds as themselves. A PAT
 * owns them as the person who minted it (the principal), so an agent cannot
 * quietly take ownership of a feed. A legacy token with no recorded creator
 * has no owner and cannot create feeds (fail-closed, same rule as approvals).
 */
export function feedOwner(actor: Actor): string | null {
  if (actor.type === "user") return actor.principalId ?? actor.id;
  return actor.principalId ?? null;
}

/**
 * Public origin for feed URLs and deep links. NEXT_PUBLIC_APP_URL wins, so a
 * self-hosted instance behind a proxy hands out its public address rather than
 * the internal one the request arrived on.
 */
export function publicBaseUrl(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  return (configured || new URL(request.url).origin).replace(/\/+$/, "");
}

export function feedUrl(baseUrl: string, raw: string): string {
  return `${baseUrl}/api/calendar/${raw}${ICS_SUFFIX}`;
}

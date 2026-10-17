import { createHash, randomBytes } from "node:crypto";
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

// ── what a poll returns ────────────────────────────────────────────────────

/**
 * A subscription answers "what is on my calendar", not "everything that ever
 * happened". The feed covers milestones from this many days back to the end of
 * the schedule, in date order. Older, long-finished milestones fall out of the
 * subscribed calendar (a subscribing client replaces its copy on every poll),
 * which is what keeps a years-old workspace from growing the response without
 * bound and from running into the database's row ceiling.
 */
export const FEED_PAST_DAYS = 90;
/** Rows per database round trip. Below the 1,000-row ceiling PostgREST applies silently. */
export const FEED_PAGE_SIZE = 500;
/**
 * Hard cap on events in one feed. Reaching it is reported (the
 * `X-NoPM-Feed-Truncated` header and a server log), never silent. Events are
 * served in date order from the window start, so what a capped feed loses is
 * the far end of the schedule, not the near-term milestones.
 */
export const FEED_MAX_EVENTS = 2_000;

/** First date (YYYY-MM-DD, UTC) a feed includes. */
export function feedWindowStart(now: Date = new Date()): string {
  return new Date(now.getTime() - FEED_PAST_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Strong validator for a feed body. The serialiser is deterministic (an
 * unchanged workspace gives identical bytes), so a hash of the body is an exact
 * "has it changed" signal. Calendar clients send it back as `If-None-Match` and
 * get a body-less 304 instead of re-downloading hundreds of kilobytes.
 */
export function feedEtag(body: string): string {
  return `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
}

/** RFC 9110 `If-None-Match` (weak comparison): a list of tags, or `*`. */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  const wanted = strip(etag);
  return ifNoneMatch
    .split(",")
    .map(strip)
    .some((tag) => tag === "*" || tag === wanted);
}

// ── throttling ─────────────────────────────────────────────────────────────

/** Requests per minute per client address, counted before the token is even looked up. */
export const FEED_RATE_PER_IP = Number(process.env.NOPM_RATE_CAL_IP_PER_MIN ?? 120);
/** Requests per minute per feed. Calendar apps poll every 15 minutes to a few hours. */
export const FEED_RATE_PER_FEED = Number(process.env.NOPM_RATE_CAL_PER_MIN ?? 60);
const RATE_WINDOW_SECONDS = 60;

/**
 * The client address as the platform proxy reports it. Used only as a rate-limit
 * key, never as an identity: a spoofed value can at worst spend someone else's
 * bucket or dodge its own, and the per-feed bucket does not depend on it.
 */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
  return candidate.slice(0, 64).replace(/[^0-9a-zA-Z:.%-]/g, "_");
}

type RateDb = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> };

/**
 * Same mechanism as src/lib/api/rate-limit.ts and the Lark webhook: the
 * `nopm_rate_check` RPC, a row-locked fixed window that holds across serverless
 * instances. `route()` only rate-limits authenticated callers, and this route
 * is public, so it calls the counter itself. Fail-OPEN on infrastructure errors
 * (an abuse guard, not an auth control), loudly.
 */
export async function feedRateCheck(
  db: RateDb,
  key: string,
  max: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const { data, error } = await db.rpc("nopm_rate_check", {
    p_key: key,
    p_max: max,
    p_window_seconds: RATE_WINDOW_SECONDS,
  });
  if (error) {
    console.error("[nopm][calendar] nopm_rate_check RPC failed - FAILING OPEN (cap not enforced this call)", {
      key: key.split(":")[0],
      error: error.message,
    });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const result = data as { allowed: boolean; retry_after_seconds: number };
  return { allowed: result.allowed, retryAfterSeconds: result.retry_after_seconds };
}

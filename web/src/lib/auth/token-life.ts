/**
 * Decision 21 - personal access token life.
 * New tokens default to 90 days and may not exceed 365. The token list warns
 * when fewer than 14 days are left. Tokens minted before this release keep
 * whatever expires_at they have (usually none): nothing here rewrites them.
 */

export const TOKEN_DEFAULT_DAYS = 90;
export const TOKEN_MAX_DAYS = 365;
export const TOKEN_WARN_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export type TokenExpiryResult =
  | { ok: true; expiresAt: string; defaulted: boolean }
  | { ok: false; message: string };

/** Resolve the expires_at to store for a new token. */
export function resolveTokenExpiry(requested: string | undefined, now: Date = new Date()): TokenExpiryResult {
  if (requested === undefined) {
    return { ok: true, expiresAt: new Date(now.getTime() + TOKEN_DEFAULT_DAYS * DAY_MS).toISOString(), defaulted: true };
  }
  const at = Date.parse(requested);
  if (!Number.isFinite(at)) return { ok: false, message: "expires_at must be an ISO-8601 datetime string" };
  if (at <= now.getTime()) return { ok: false, message: "expires_at must be in the future" };
  if (at > now.getTime() + TOKEN_MAX_DAYS * DAY_MS) {
    return { ok: false, message: `A token can last at most ${TOKEN_MAX_DAYS} days. Pick an earlier expires_at.` };
  }
  return { ok: true, expiresAt: new Date(at).toISOString(), defaulted: false };
}

/** Whole days left (rounded up), or null for a token that never expires. Negative when already expired. */
export function tokenDaysLeft(expiresAt: string | null | undefined, now: Date = new Date()): number | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return null;
  return Math.ceil((at - now.getTime()) / DAY_MS);
}

/** True for an active token with 0..13 days left (not for never-expiring or already-expired ones). */
export function tokenExpiresSoon(expiresAt: string | null | undefined, now: Date = new Date()): boolean {
  const left = tokenDaysLeft(expiresAt, now);
  return left !== null && left >= 0 && left < TOKEN_WARN_DAYS;
}

import { isIP } from "node:net";

/**
 * Client IP for the pre-auth, IP-keyed rate limits (POST /api/invites/accept,
 * the Lark relay). The key only means something if the address cannot be chosen
 * by the caller, and `X-Forwarded-For` is a plain request header: the FIRST
 * entry is whatever the client wrote. Both limiters used to key on it, so
 * rotating the header gave every request a fresh bucket (R1 E1.4) and the cap
 * did nothing. The HMAC / invite token stayed the real control, but the limiter
 * is what bounds guessing and account minting.
 *
 * Which header to believe depends on who set it:
 *
 *  - On Vercel (`VERCEL` is set in the function runtime) the platform sets
 *    `x-vercel-forwarded-for` and `x-real-ip` itself and overwrites any value
 *    the client sent. We read `x-vercel-forwarded-for`, then `x-real-ip`, then
 *    the LAST `x-forwarded-for` entry (the one Vercel's edge appended). Never
 *    the first.
 *  - Anywhere else (self-host, Docker, local dev) NOTHING is trusted by default:
 *    any of those headers could be written by the caller, and the app cannot
 *    see the socket address. Set `NOPM_TRUSTED_PROXY_HOPS=<n>` to the number of
 *    reverse proxies YOU run in front of the app (1 for a single nginx / Caddy /
 *    load balancer) and the address is read from the right of
 *    `x-forwarded-for`: each trusted proxy appends the peer it saw, so the entry
 *    `n` places from the right is the first one a client cannot spoof. Entries
 *    further left are ignored. Fewer entries than hops means the request did
 *    not come through your proxies, so it is distrusted too.
 *
 * Returns `null` when no address can be trusted. The callers decide what that
 * means: invites/accept falls back to a per-invite-token bucket (a flood only
 * throttles the token it targets), the Lark relay skips its pre-auth IP cap and leans on the HMAC and the
 * per-connector cap. The value is always a syntactically valid IP, so a header
 * full of junk can neither mint unbounded rate keys nor reach the RPC.
 *
 * `ipRateKey` is the variant to build a rate-limit key from: identical for
 * IPv4, but an IPv6 address collapses to its /64. A single subscriber is handed
 * a whole /64, so keying on the full address would let one client rotate
 * through 2^64 "different" callers: each fresh key is a fresh bucket (the cap
 * does nothing) and a fresh counter row (unbounded growth). The key space a
 * caller can reach is therefore bounded by the networks it really holds.
 */
export function clientIp(headers: Headers, env: Record<string, string | undefined> = process.env): string | null {
  const onVercel = !!env.VERCEL && env.VERCEL !== "0";
  if (onVercel) {
    return (
      validIp(firstEntry(headers.get("x-vercel-forwarded-for"))) ??
      validIp(headers.get("x-real-ip")) ??
      fromForwardedFor(headers.get("x-forwarded-for"), 1)
    );
  }
  const hops = trustedProxyHops(env.NOPM_TRUSTED_PROXY_HOPS);
  if (hops === 0) {
    warnNoTrustedProxyOnce();
    return null;
  }
  return fromForwardedFor(headers.get("x-forwarded-for"), hops);
}

let warnedNoTrustedProxy = false;

/**
 * One line per process, the first time an address is wanted and none can be
 * trusted (off Vercel, NOPM_TRUSTED_PROXY_HOPS unset/0). Without it a self-host
 * operator never learns that invite-accept shares ONE bucket across all callers.
 * Behaviour is unchanged: the caller still gets `null`.
 */
function warnNoTrustedProxyOnce(): void {
  if (warnedNoTrustedProxy) return;
  warnedNoTrustedProxy = true;
  console.warn(
    "[client-ip] NOPM_TRUSTED_PROXY_HOPS is not set and this is not Vercel, so no client address can be trusted: " +
      "POST /api/invites/accept puts every caller in one shared rate-limit bucket, and the Lark relay skips its per-address cap. " +
      "Set NOPM_TRUSTED_PROXY_HOPS to the number of reverse proxies in front of the app (1 for a single nginx, Caddy or load balancer); " +
      "see docs/SELF_HOSTING.md.",
  );
}

/** Test seam: forget that the warning was already logged. */
export function resetNoTrustedProxyWarning(): void {
  warnedNoTrustedProxy = false;
}

/** Number of reverse proxies in front of the app that append to x-forwarded-for. 0 (default) = trust none. */
export function trustedProxyHops(raw: string | undefined): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isInteger(n) || n < 0) return 0;
  return Math.min(n, 8);
}

function firstEntry(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

/** The entry `hops` places from the right of an x-forwarded-for chain. */
function fromForwardedFor(value: string | null, hops: number): string | null {
  if (!value) return null;
  const entries = value
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length < hops) return null;
  return validIp(entries[entries.length - hops]);
}

/** A syntactically valid IP (v4 or v6), lower-cased, with an IPv4-mapped IPv6 address unwrapped; else null. */
function validIp(value: string | null | undefined): string | null {
  const v = value?.trim().toLowerCase();
  if (!v || isIP(v) === 0) return null;
  const mapped = v.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  return v;
}

/**
 * The key part to use for per-client rate limiting: `clientIp`, with an IPv6
 * address collapsed to its /64 network (`2001:db8:0:1::/64`), or null when no
 * address can be trusted. Always safe to splice into a key: it is built from
 * a validated address, never from raw header text.
 */
export function ipRateKey(headers: Headers, env: Record<string, string | undefined> = process.env): string | null {
  const ip = clientIp(headers, env);
  if (!ip) return null;
  return isIP(ip) === 6 ? ipv6Network64(ip) : ip;
}

/** First four hextets of an IPv6 address, normalised, as `a:b:c:d::/64`. */
function ipv6Network64(ip: string): string {
  let s = ip.split("%")[0];
  const v4 = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [, a, b, c, d] = v4.map(Number);
    s = s.slice(0, s.length - v4[0].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const halves = s.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return groups.slice(0, 4).map((g) => Number.parseInt(g || "0", 16).toString(16)).join(":") + "::/64";
}

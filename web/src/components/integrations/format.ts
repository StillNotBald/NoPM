/**
 * Integrations console — pure display + URL helpers.
 *
 * Kept free of React and of `window`/`Date.now()` reads (callers pass `now`
 * and `origin` in) so every rule here unit-tests under the repo's node-only
 * vitest environment, and so no component has to call an impure function
 * during render.
 */

/** A link code is valid for 10 minutes (PLAN D7). Used when the API omits an expiry. */
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * `m:ss` countdown for a remaining duration in ms. Rounds UP to the next
 * whole second (so the last second reads 0:01, never a premature 0:00) and
 * clamps at 0:00 once expired.
 */
export function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.ceil(msRemaining / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Milliseconds left until an absolute expiry (epoch ms); never negative. */
export function remainingMs(expiresAtMs: number, nowMs: number): number {
  return Math.max(0, expiresAtMs - nowMs);
}

/**
 * Absolute expiry (epoch ms) from whatever the API gave us: an ISO string, or
 * nothing / garbage (then `now + ttl`, i.e. "10 minutes from receipt").
 */
export function parseExpiry(expiresAt: unknown, nowMs: number, ttlMs: number = LINK_CODE_TTL_MS): number {
  if (typeof expiresAt === "string") {
    const t = Date.parse(expiresAt);
    if (Number.isFinite(t)) return t;
  }
  return nowMs + ttlMs;
}

/** The exact chat message the user sends to the bot to link their account. */
export function linkMessage(code: string): string {
  return `link ${code.trim()}`;
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The two callback URLs an admin pastes into the Lark developer console for a
 * hosted (webhook-mode) connector. Absolute, derived from the page origin.
 */
export function larkWebhookUrls(origin: string, connectorId: string): { events: string; card: string } {
  const base = `${trimTrailingSlashes(origin)}/api/integrations/lark/${encodeURIComponent(connectorId)}`;
  return { events: `${base}/events`, card: `${base}/card` };
}

/** Server-built callback URLs from the connector API (they honour the configured app URL). */
export interface CallbackUrls {
  events: string;
  card: string;
  relay: string | null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The app URL the server built its callback URLs from: everything before
 * `/api/integrations/lark/<id>/…` (so a path prefix is preserved), else the
 * bare origin of the events URL.
 */
export function appUrlFromCallbackUrls(urls: CallbackUrls): string | null {
  const stripped = urls.events.replace(/\/api\/integrations\/lark\/[^/]+\/events\/?$/, "");
  if (stripped !== urls.events && /^https?:\/\//i.test(stripped)) return trimTrailingSlashes(stripped);
  return originOf(urls.events);
}

/**
 * Which webhook URLs to show an admin, and whether to warn about a mismatch.
 *
 * Server-built `callback_urls` win: they use the configured app URL
 * (NEXT_PUBLIC_APP_URL) and are what the server will actually accept. The
 * browser address is only a fallback for a response that lacks them. When both
 * exist and name different hosts, the URLs are still the server's, with a
 * one-line hint that the app URL setting differs from the current address.
 */
export function resolveWebhookUrls(args: {
  serverUrls: CallbackUrls | null;
  /** `window.location.origin`, or "" when unknown (server render). */
  origin: string;
  connectorId: string;
}): { events: string; card: string; source: "server" | "browser"; hint: string | null } | null {
  const { serverUrls, origin, connectorId } = args;
  if (serverUrls) {
    const serverOrigin = originOf(serverUrls.events);
    const here = trimTrailingSlashes(origin);
    const hint =
      here && serverOrigin && serverOrigin !== here
        ? `Your app URL setting (${serverOrigin}) differs from the address you're using now (${here}). Lark calls the configured one, so paste these as shown.`
        : null;
    return { events: serverUrls.events, card: serverUrls.card, source: "server", hint };
  }
  if (!origin) return null;
  return { ...larkWebhookUrls(origin, connectorId), source: "browser", hint: null };
}

/** The app URL for the self-host worker: the server's configured one when known, else the browser's. */
export function resolveAppUrl(args: { serverUrls: CallbackUrls | null; origin: string }): string {
  const fromServer = args.serverUrls ? appUrlFromCallbackUrls(args.serverUrls) : null;
  return trimTrailingSlashes(fromServer ?? args.origin);
}

/** Makes an API-returned URL absolute; a root-relative path gets the page origin. */
export function absoluteUrl(url: string, origin: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `${trimTrailingSlashes(origin)}${url}`;
  return url;
}

/** `https://…` -> `webcal://…`, the scheme calendar apps open as a subscription. */
export function toWebcalUrl(url: string): string {
  return url.replace(/^https?:/i, "webcal:");
}

/**
 * The environment a self-hosted long-connection worker needs from NoPM. The
 * relay secret line is included only while it is still known (just after the
 * connector is created); afterwards only the non-secret lines remain.
 */
export function workerEnvBlock(args: { origin: string; connectorId: string; relaySecret?: string | null }): string {
  const lines = [`NOPM_APP_URL=${trimTrailingSlashes(args.origin)}`, `NOPM_LARK_CONNECTOR_ID=${args.connectorId}`];
  if (args.relaySecret) lines.push(`NOPM_LARK_RELAY_SECRET=${args.relaySecret}`);
  return lines.join("\n");
}

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** 0 = Sunday … 6 = Saturday (the connector's `digest.weekday`). */
export function weekdayLabel(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 6 ? WEEKDAYS[n] : "—";
}

/** Group chat ids are `oc_…`; returns an error message, or null when acceptable. */
export function validateChatId(value: string): string | null {
  const v = value.trim();
  if (!v) return "Enter the group chat ID the digest should be posted to.";
  if (!/^oc_[A-Za-z0-9]{8,}$/.test(v)) return "Group chat IDs start with oc_ (for example oc_1a2b3c4d5e6f).";
  return null;
}

/** "Never" / "Just now" / "5m ago" / "3h ago" / "2d ago", relative to an explicit `now`. */
export function formatRelativeTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "Never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "Never";
  const mins = Math.floor((nowMs - t) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "16 Oct 2026" (en-GB, same as the approvals register); "—" for a missing/invalid date. */
export function formatDate(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric", timeZone });
}

/** "1 teammate" / "3 teammates". */
export function pluralise(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

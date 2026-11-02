/**
 * HTTP flow of the hosted Telegram webhook route (ADR 0020):
 *
 *   uuid check -> connector lookup -> capped body -> secret-token header
 *   (constant time) -> per-connector rate limit -> `handleTelegramUpdate`.
 *
 * Everything unauthenticated is ONE generic 401: an unknown, revoked or
 * mis-secreted connector looks the same and costs the same work. A connector
 * that is only paused is authenticated normally and the handler answers "turned
 * off". The body is never logged. I/O arrives through `TelegramWebhookDeps`.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { readCappedBody } from "@/lib/integrations/body";
import { safeEqual } from "@/lib/integrations/lark/verify";
import type { ConnectorRow } from "@/lib/integrations/types";
import { handleTelegramUpdate, type LogLevel, type TelegramContext, type TelegramDeps } from "./handlers";
import type { TelegramSecrets } from "./secrets";

export const SECRET_HEADER = "x-telegram-bot-api-secret-token";
export const MAX_UPDATE_BODY_BYTES = 256 * 1024;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Authenticated updates per minute per connector. */
export const WEBHOOK_RATE_MAX = Number(process.env.NOPM_RATE_TELEGRAM_PER_MIN ?? 300);
export const WEBHOOK_BAD_ATTEMPTS_MAX = 30;
/**
 * Authenticated updates per minute per Telegram sender, counted INSIDE the connector budget and before it: one
 * noisy sender is dropped here and never spends the budget every linked member shares. Higher than the handler's
 * own 30/min "slow down" reply, so a well-behaved person sees the polite refusal first.
 */
export const WEBHOOK_USER_RATE_MAX = Number(process.env.NOPM_RATE_TELEGRAM_SENDER_PER_MIN ?? 60);
const DECOY_SECRET = "decoy-secret-token-for-constant-work";

export type TelegramWebhookDeps = {
  loadConnector(connectorId: string): Promise<ConnectorRow | null>;
  readSecrets(connector: ConnectorRow): TelegramSecrets;
  rateCheck(key: string, max: number): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  buildContext(connector: ConnectorRow, requestOrigin: string): { ctx: TelegramContext; deps: TelegramDeps };
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
};

const NO_STORE = { "Cache-Control": "no-store" } as const;
const json = (body: unknown, status: number, extra: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...extra } });

/** The Telegram user id that sent the update (message or tap), or null. */
export function senderOf(update: unknown): string | null {
  if (!update || typeof update !== "object") return null;
  const u = update as { message?: { from?: { id?: unknown } }; callback_query?: { from?: { id?: unknown } } };
  const id = u.message?.from?.id ?? u.callback_query?.from?.id;
  return typeof id === "number" && Number.isFinite(id) ? String(id) : null;
}

export async function handleTelegramWebhook(request: NextRequest, rawConnectorId: string, wd: TelegramWebhookDeps): Promise<Response> {
  if (!UUID_RE.test(rawConnectorId)) return json({ error: "Not found" }, 404);
  const connectorId = rawConnectorId.toLowerCase();

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_UPDATE_BODY_BYTES) return json({ error: "Payload too large" }, 413);

  const connector = await wd.loadConnector(connectorId);
  const capped = await readCappedBody(request, MAX_UPDATE_BODY_BYTES);
  if (!capped.ok) return json({ error: "Payload too large" }, 413);

  const presented = request.headers.get(SECRET_HEADER) ?? "";
  let expected = DECOY_SECRET;
  let usable = !!connector && connector.status !== "revoked";
  if (connector && usable) {
    try {
      expected = wd.readSecrets(connector).webhookSecret || DECOY_SECRET;
    } catch {
      wd.log("error", "telegram connector secrets are unreadable", { connectorId });
      return json({ error: "Service unavailable" }, 503);
    }
  }
  // Always compared, even for an unknown connector, so a miss costs what a hit costs.
  const match = safeEqual(presented, expected);
  if (!connector || !usable || !match || expected === DECOY_SECRET) {
    usable = false;
    wd.log("warn", "telegram webhook rejected", { reason: !connector ? "unknown_connector" : connector.status === "revoked" ? "revoked" : "bad_secret" });
    if (connector) {
      const verdict = await wd.rateCheck(`telegram-bad:${connectorId}`, WEBHOOK_BAD_ATTEMPTS_MAX);
      if (!verdict.allowed) return json({ error: "Too many requests" }, 429, { "Retry-After": String(verdict.retryAfterSeconds) });
    }
    return json({ error: "Invalid request" }, 401);
  }

  let update: unknown;
  try {
    update = JSON.parse(capped.text);
  } catch {
    return json({}, 200); // authenticated but not JSON: nothing to do, and Telegram should not retry
  }

  // Per-sender bucket first (a flooding sender is acknowledged and dropped), then the connector-wide budget.
  const sender = senderOf(update);
  if (sender) {
    const own = await wd.rateCheck(`telegram-sender:${connectorId}:${sender}`, WEBHOOK_USER_RATE_MAX);
    if (!own.allowed) {
      wd.log("warn", "telegram sender over budget", { connectorId });
      return json({}, 200);
    }
  }
  const budget = await wd.rateCheck(`telegram:${connectorId}`, WEBHOOK_RATE_MAX);
  if (!budget.allowed) return json({ error: "Too many requests" }, 429, { "Retry-After": String(budget.retryAfterSeconds) });

  const { ctx, deps } = wd.buildContext(connector, new URL(request.url).origin);
  const result = await handleTelegramUpdate(ctx, update, deps);
  return json(result.body, result.status);
}

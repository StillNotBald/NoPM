/**
 * Shared HTTP flow of the hosted Lark / Feishu webhook routes
 * (`/api/integrations/lark/[connectorId]/events` and `/card`).
 *
 * Both routes are the same pipe on purpose — the platform lets an admin paste
 * one URL into both "Event subscription" and "Callback configuration", and
 * routing on `header.event_type` makes that harmless:
 *
 *   uuid check -> connector lookup (active only) -> raw body -> decrypt secrets
 *   -> authenticate (signature / token, ./verify.ts) -> per-connector rate
 *   limit -> `handleLarkPayload` (./handlers.ts) -> JSON reply.
 *
 * Ordering is deliberate:
 *   • Everything unauthenticated is cheap and uninformative: unknown / paused /
 *     revoked connectors are a bare 404, and every verification failure is the
 *     same generic 401 (the precise reason is logged server-side only), so the
 *     endpoint is neither a connector-existence nor a decryption oracle.
 *   • The per-connector budget is charged only AFTER authentication, so someone
 *     who merely knows a connector id cannot spend the real tenant's budget.
 *     Failed attempts are counted in their own small bucket purely to make a
 *     guessing run visible and to cap what it costs.
 *   • A card click is always answered with HTTP 200 + toast (even when rate
 *     limited): the platform renders the toast, whereas a bare 429 shows the
 *     person an opaque error.
 *
 * All I/O arrives through `WebhookDeps` so this file is unit-testable without
 * Supabase or the network; ./wiring.ts builds the production set.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { ConnectorRow, LarkSecrets } from "@/lib/integrations/types";
import { cardCallbackResponse } from "./cards";
import { handleLarkPayload, type LarkHandlerContext, type LarkHandlerDeps, type LogLevel } from "./handlers";
import { MAX_WEBHOOK_BODY_BYTES, verifyLarkRequest } from "./verify";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Requests per minute per connector once authenticated (card clicks + bot DMs). */
export const WEBHOOK_RATE_MAX = Number(process.env.NOPM_RATE_LARK_PER_MIN ?? 300);
/** Failed-authentication attempts per minute per connector that we will keep paying for. */
export const WEBHOOK_BAD_ATTEMPTS_MAX = 30;

export type WebhookDeps = {
  /** Connector by id regardless of status (the id is the only thing the URL carries). */
  loadConnector(connectorId: string): Promise<ConnectorRow | null>;
  /** Decrypt the connector's stored secrets; may throw. */
  readSecrets(connector: ConnectorRow): LarkSecrets;
  /** DB-backed fixed-window counter; fail-open on infrastructure errors. */
  rateCheck(key: string, max: number): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  buildContext(
    connector: ConnectorRow,
    secrets: LarkSecrets,
    requestOrigin: string,
  ): { ctx: LarkHandlerContext; deps: LarkHandlerDeps };
  now(): number;
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
};

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status: number, extra: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...extra } });
}

export async function handleLarkWebhook(request: NextRequest, rawConnectorId: string, wd: WebhookDeps): Promise<Response> {
  if (!UUID_RE.test(rawConnectorId)) return json({ error: "Not found" }, 404);
  // Canonical form, so an upper-case spelling of the same uuid cannot open a second rate-limit bucket.
  const connectorId = rawConnectorId.toLowerCase();

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_WEBHOOK_BODY_BYTES) return json({ error: "Payload too large" }, 413);

  const connector = await wd.loadConnector(connectorId);
  if (!connector || connector.status !== "active") return json({ error: "Not found" }, 404);

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) return json({ error: "Payload too large" }, 413);

  let secrets: LarkSecrets;
  try {
    secrets = wd.readSecrets(connector);
  } catch {
    wd.log("error", "lark connector secrets are unreadable", { connectorId });
    return json({ error: "Connector is misconfigured" }, 500);
  }

  const verdict = verifyLarkRequest({ rawBody, headers: request.headers, secrets, now: wd.now });
  if (!verdict.ok) {
    wd.log("warn", "lark webhook rejected", { connectorId, reason: verdict.reason });
    const bad = await wd.rateCheck(`lark-bad:${connectorId}`, WEBHOOK_BAD_ATTEMPTS_MAX);
    return bad.allowed
      ? json({ error: "Invalid request" }, 401)
      : json({ error: "Too many requests" }, 429, { "Retry-After": String(bad.retryAfterSeconds) });
  }

  // Authenticated from here: it is now safe to say why a connector refuses.
  if (connector.config.mode !== "webhook") {
    return json({ error: "Connector is not in webhook mode", code: "wrong_mode" }, 403);
  }

  const envelope = verdict.envelope;
  const isCard = envelope.header?.event_type === "card.action.trigger";
  const budget = await wd.rateCheck(`lark:${connectorId}`, WEBHOOK_RATE_MAX);
  if (!budget.allowed) {
    return isCard
      ? json(cardCallbackResponse("warning", "Too many requests right now. Try again in a minute, or decide in NoPM."), 200)
      : json({ error: "Too many requests" }, 429, { "Retry-After": String(budget.retryAfterSeconds) });
  }

  const { ctx, deps } = wd.buildContext(connector, secrets, new URL(request.url).origin);
  const result = await handleLarkPayload(ctx, envelope, deps);
  return json(result.body, result.status);
}

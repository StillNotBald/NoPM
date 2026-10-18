import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Self-host relay protocol (2026-10-16, PLAN.md D5) — the signing contract
 * between `web/scripts/lark-worker.mjs` (a long-connection listener that runs
 * next to a self-hosted NoPM) and `POST /api/integrations/lark/[connectorId]/relay`.
 *
 * Why a relay exists: Lark's long-connection mode (WebSocket, self-built apps
 * only) lets a self-hoster with NO public URL receive events, but the
 * WebSocket terminates in the worker process, not in the Next.js app. The
 * worker therefore forwards each event over a local, HMAC-signed HTTP POST so
 * the governed inbound pipeline exists exactly once (the same handlers the
 * hosted webhook routes call) — a second code path for approvals would be a
 * second place for four-eyes to be wrong.
 *
 * Wire format
 *   POST {NOPM_APP_URL}/api/integrations/lark/{connectorId}/relay
 *   X-NoPM-Relay-Timestamp: <unix seconds, decimal>
 *   X-NoPM-Relay-Signature: v1=<hex(hmac_sha256(key, timestamp + "." + rawBody))>
 *   body: { "type": "event" | "card" | "ping", "payload": <Lark v2 envelope> }
 *
 * Choice of HMAC key — the SHA-256 of the raw relay secret, NOT the raw secret:
 *   - NoPM shows the raw secret exactly once (connector creation) and stores
 *     only `relay_secret_hash = sha256_hex(raw)` (same shape as PAT hashes), so
 *     there is nothing reversible at rest and no second encryption key to
 *     manage for it.
 *   - The worker holds the raw secret and derives `key = sha256_hex(raw)`; the
 *     server uses the stored hash AS the key. Both sides therefore compute the
 *     same HMAC without the server ever needing the raw secret back.
 *   - Honest trade-off: the stored hash is itself enough to sign a relay
 *     request, so a database read leaks "can talk to the relay" for that
 *     connector. Bounded by design: a forged relay call still needs a valid,
 *     single-use, recipient-bound action token (stored hashed) or a live
 *     link code to change anything, and every decision runs the same governed
 *     path (identity link, four-eyes, one audit row). A DB-write attacker could
 *     already do far worse; a DB-read attacker gets no approval power.
 *
 * Replay: the timestamp window (±5 min) only bounds how long a captured
 * request stays usable; it is not a nonce store (the route is stateless on
 * Vercel). Replay safety comes from the layer below — inbound actions are
 * idempotent on (connector_id, external_event_id) and action tokens / link
 * codes are single-use — so a replayed relay request is a no-op. Run the
 * worker against an https NoPM URL anyway: the body carries chat text.
 */

export const RELAY_TIMESTAMP_HEADER = "x-nopm-relay-timestamp";
export const RELAY_SIGNATURE_HEADER = "x-nopm-relay-signature";
export const RELAY_SIGNATURE_VERSION = "v1";
/** ± window around "now" inside which a signed timestamp is accepted. */
export const RELAY_TOLERANCE_SECONDS = 300;
/** Lark events and card callbacks are a few KB; anything near this is abuse. */
export const RELAY_MAX_BODY_BYTES = 256 * 1024;

/**
 * Stable `code` values the relay route puts in its `{ error, code }` bodies.
 * The worker keys its operator-facing messages off these (and off the HTTP
 * status), so treat them as part of the wire contract.
 */
export const RELAY_ERROR_CODES = {
  invalidSignature: "invalid_relay_signature",
  staleTimestamp: "stale_relay_timestamp",
  noSecret: "no_relay_secret",
  notFound: "connector_not_found",
  inactive: "connector_inactive",
  wrongMode: "wrong_mode",
  tooLarge: "body_too_large",
  invalidRequest: "invalid_relay_request",
} as const;

const SIGNATURE_RE = /^v1=([0-9a-f]{64})$/;
const TIMESTAMP_RE = /^\d{1,12}$/;
const KEY_RE = /^[0-9a-f]{64}$/;

/**
 * `relay_secret_hash` for a raw relay secret: lowercase hex SHA-256. Byte-for-byte
 * the same as `hashToken` (PAT hashing) so the hub core can store it with
 * either helper; asserted against a published SHA-256 vector in relay.test.ts.
 */
export function hashRelaySecret(rawSecret: string): string {
  return createHash("sha256").update(rawSecret).digest("hex");
}

function hmacHex(secretHash: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secretHash).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** `v1=<hex>` — HMAC-SHA256 of `timestamp + "." + rawBody` under the hashed secret. */
export function signRelayBody(secretHash: string, timestamp: string, rawBody: string): string {
  return `${RELAY_SIGNATURE_VERSION}=${hmacHex(secretHash, timestamp, rawBody)}`;
}

/** Worker-side helper (also used by tests): headers for a request carrying `rawBody`. */
export function buildRelayHeaders(
  rawSecret: string,
  rawBody: string,
  nowMs: number = Date.now(),
): Record<string, string> {
  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    [RELAY_TIMESTAMP_HEADER]: timestamp,
    [RELAY_SIGNATURE_HEADER]: signRelayBody(hashRelaySecret(rawSecret), timestamp, rawBody),
  };
}

export type RelayVerifyFailure =
  | "no_secret" //     connector has no (or a malformed) stored relay secret hash — fail closed
  | "missing_headers"
  | "bad_timestamp"
  | "stale" //         outside ±RELAY_TOLERANCE_SECONDS
  | "bad_signature";

export type RelayVerifyResult = { ok: true } | { ok: false; reason: RelayVerifyFailure };

/**
 * Verify a relayed request against the connector's stored secret hash.
 * Checks, in order: a usable stored hash, header presence + shape, clock
 * window, then the HMAC in constant time over the exact raw bytes received
 * (verify BEFORE JSON.parse — re-serialising would change the signed bytes).
 */
export function verifyRelaySignature(input: {
  secretHash: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  rawBody: string;
  nowMs?: number;
}): RelayVerifyResult {
  const { secretHash, timestamp, signature, rawBody } = input;
  const nowMs = input.nowMs ?? Date.now();

  if (!secretHash || !KEY_RE.test(secretHash)) return { ok: false, reason: "no_secret" };
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };
  if (!TIMESTAMP_RE.test(timestamp)) return { ok: false, reason: "bad_timestamp" };

  const skew = Math.abs(Math.floor(nowMs / 1000) - Number(timestamp));
  if (skew > RELAY_TOLERANCE_SECONDS) return { ok: false, reason: "stale" };

  const match = SIGNATURE_RE.exec(signature);
  if (!match) return { ok: false, reason: "bad_signature" };

  const expected = Buffer.from(hmacHex(secretHash, timestamp, rawBody), "hex");
  const received = Buffer.from(match[1], "hex");
  // Both are 32 bytes by construction (regex + HMAC-SHA256), so timingSafeEqual
  // cannot throw on a length mismatch.
  return timingSafeEqual(expected, received) ? { ok: true } : { ok: false, reason: "bad_signature" };
}

/**
 * Body of a relay call. `payload` is the Lark v2 event envelope
 * `{ schema, header: { event_id, event_type, tenant_key, app_id, ... }, event }`
 * — the same shape the hosted webhook routes receive, so one handler serves
 * both transports. `ping` is a signed no-op the worker sends at boot to prove
 * URL, connector id, secret and mode before it opens the WebSocket.
 */
const envelopeSchema = z
  .object({
    schema: z.string().optional(),
    header: z
      .object({
        event_id: z.string().min(1).max(256),
        event_type: z.string().min(1).max(128),
      })
      .passthrough(),
    event: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const CARD_ACTION_EVENT_TYPE = "card.action.trigger";

export const relayRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("event"), payload: envelopeSchema }),
  z.object({ type: z.literal("card"), payload: envelopeSchema }),
]);

export type RelayRequest = z.infer<typeof relayRequestSchema>;
export type RelayEnvelope = z.infer<typeof envelopeSchema>;

/**
 * `type` and `header.event_type` must agree. A "card" call carrying a message
 * event (or the reverse) is a malformed or confused client, and routing it to
 * the wrong handler would be an avoidable ambiguity in a governed path.
 */
export function relayTypeMatchesEvent(req: Extract<RelayRequest, { payload: unknown }>): boolean {
  const isCardEvent = req.payload.header.event_type === CARD_ACTION_EVENT_TYPE;
  return req.type === "card" ? isCardEvent : !isCardEvent;
}

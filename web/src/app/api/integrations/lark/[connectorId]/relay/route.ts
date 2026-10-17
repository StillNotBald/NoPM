import { NextResponse } from "next/server";
import { route } from "@/lib/api/handler";
import { ApiError, NotFoundError, RateLimitError } from "@/lib/api/errors";
import { ipRateKey } from "@/lib/api/client-ip";
import { validationError } from "@/lib/api/response";
import { createAdminClient } from "@/lib/supabase/admin";
import { readCappedBody } from "@/lib/integrations/body";
import { CONNECTOR_COLUMNS, normalizeConfig } from "@/lib/integrations/store";
import type { ConnectorRow } from "@/lib/integrations/types";
import { cardCallbackResponse } from "@/lib/integrations/lark/cards";
import { handleLarkPayload } from "@/lib/integrations/lark/handlers";
import { productionContext } from "@/lib/integrations/lark/wiring";
import {
  RELAY_ERROR_CODES,
  RELAY_MAX_BODY_BYTES,
  RELAY_SIGNATURE_HEADER,
  RELAY_TIMESTAMP_HEADER,
  relayRequestSchema,
  relayTypeMatchesEvent,
  verifyRelaySignature,
} from "@/lib/integrations/lark/relay";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store" } as const;
/** A well-formed hash nobody holds the preimage of: what the verifier runs against when the id matches no connector. */
const DECOY_RELAY_HASH = "0".repeat(64);

/** Pre-auth guard, per client IP: keeps unauthenticated garbage off the connector lookup. */
const IP_RATE_MAX = 120;
/** Post-auth guard, per connector: bounds a runaway (or hostile tenant's) worker. */
const CONNECTOR_RATE_MAX = 600;
const RATE_WINDOW_SECONDS = 60;

/**
 * Same baseline as invites/accept and lib/api/rate-limit.ts: DB-backed fixed
 * window via nopm_rate_check, FAIL-OPEN on infrastructure error (abuse guard,
 * not an auth control), loud in the logs so an unenforced cap is observable.
 */
async function rateCheck(
  db: ReturnType<typeof createAdminClient>,
  key: string,
  max: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const { data, error } = await db.rpc("nopm_rate_check", {
    p_key: key,
    p_max: max,
    p_window_seconds: RATE_WINDOW_SECONDS,
  });
  if (error) {
    console.error("[nopm][lark-relay] nopm_rate_check RPC failed — FAILING OPEN (cap not enforced this call)", {
      key,
      error: error.message,
    });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const rate = data as { allowed: boolean; retry_after_seconds: number };
  return { allowed: rate.allowed, retryAfterSeconds: rate.retry_after_seconds };
}

/**
 * POST /api/integrations/lark/[connectorId]/relay — public (auth:false), the
 * self-host transport of the Lark integration.
 *
 * A self-hosted NoPM has no public URL, so Lark cannot call the webhook routes.
 * `web/scripts/lark-worker.mjs` holds an OUTBOUND long-connection (WebSocket)
 * to Lark and forwards each event here, signed with the connector's relay
 * secret (see lib/integrations/lark/relay.ts). From this point the request
 * takes the SAME governed path as a hosted webhook delivery: `handleLarkPayload`
 * maps the click to a linked NoPM user, then decideApproval enforces scopes,
 * four-eyes and the one-audit-row rule with channel "lark". This route
 * authenticates the TRANSPORT (who may talk to this connector); it never
 * decides an approval itself and writes no audit row of its own — a ping and a
 * rejected request mutate nothing.
 *
 * Body:  { type: "event" | "card", payload: <Lark v2 envelope> } | { type: "ping" }
 *        The envelope carries no verification token (the HMAC replaces it).
 * 200:   event -> {} (a bot reply, if any, is sent after the response, so the
 *        worker is never held for a Lark API call); card -> the handler's JSON,
 *        returned to Lark VERBATIM as the callback response ({ toast, card }),
 *        hence not wrapped in { data }; ping -> { data: { ok, connector_id, mode, status } }.
 * Errors use the standard { error, code } contract:
 *        401 invalid_relay_signature | stale_relay_timestamp | no_relay_secret
 *        (an unknown connector id is the same 401 invalid_relay_signature: before
 *        the HMAC is checked nothing says whether a connector exists),
 *        403 connector_inactive | wrong_mode (authenticated callers only),
 *        404 connector_not_found (a malformed id only), 413 body_too_large,
 *        422 invalid_relay_request, 429 rate_limited, 503 connector_unavailable
 *        (its secrets cannot be decrypted), 500 sanitised. (A rate-limited CARD click is answered 200 with a toast
 *        instead, like the webhook routes: the person sees words, not an error code.)
 *
 * Order matters: (1) cheap shape checks, (2) IP-keyed rate limit running in
 * parallel with the connector lookup (no added latency), (3) HMAC over the raw
 * bytes BEFORE parsing, (4) only then reveal connector state (inactive / wrong
 * mode) to the now-authenticated caller, (5) validate the body, (6)
 * per-connector rate limit, (7) route. Lark gives a card click 3 s end to end;
 * the worker allows 2.5 s for this call.
 */
export const POST = route(
  async ({ request, params }) => {
    const connectorId = params.connectorId ?? "";
    if (!UUID_RE.test(connectorId)) {
      throw new NotFoundError("Connector not found", RELAY_ERROR_CODES.notFound);
    }

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > RELAY_MAX_BODY_BYTES) {
      throw new ApiError(413, "Relay body too large", RELAY_ERROR_CODES.tooLarge);
    }

    const db = createAdminClient();
    // The key comes from the address the operator's own proxy appended (IPv6
    // collapsed to its /64), never from a header the caller wrote, so rotating
    // a header buys neither a fresh bucket nor a fresh counter row. With no
    // trustworthy address (app exposed directly, no proxy) every caller would
    // share one bucket and a stranger could lock the real worker out; in that
    // case skip the pre-auth cap and rely on the HMAC + per-connector cap.
    const ip = ipRateKey(request.headers);
    const [ipRate, lookup] = await Promise.all([
      ip ? rateCheck(db, `lark-relay-ip:${ip}`, IP_RATE_MAX) : Promise.resolve(null),
      db.from("integration_connectors").select(CONNECTOR_COLUMNS).eq("id", connectorId).eq("kind", "lark").maybeSingle(),
    ]);
    if (ipRate && !ipRate.allowed) {
      throw new RateLimitError(`Rate limit exceeded. Retry in ${ipRate.retryAfterSeconds}s.`);
    }
    if (lookup.error) throw lookup.error;
    // The connector row IS the workspace binding for everything below
    // (handlers read connector.workspace_id); there is no workspace to filter
    // by before it is loaded, the id is an unguessable uuid, and the HMAC check
    // right after proves the caller holds this connector's relay secret.
    // An unknown id gets the same 401 a wrong signature does (below), after the
    // same work, so a caller without the relay secret cannot tell "no such
    // connector" from "wrong secret".
    const row = (lookup.data ?? null) as unknown as ConnectorRow | null;
    // `config` is free-form jsonb: normalise so `mode` is never undefined.
    const found: ConnectorRow | null = row ? { ...row, config: normalizeConfig(row.config) } : null;

    // Capped stream read: a chunked body has no Content-Length, so the cap must hold while reading.
    const capped = await readCappedBody(request, RELAY_MAX_BODY_BYTES);
    if (!capped.ok) {
      throw new ApiError(413, "Relay body too large", RELAY_ERROR_CODES.tooLarge);
    }
    const rawBody = capped.text;

    if (!found) {
      verifyRelaySignature({
        secretHash: DECOY_RELAY_HASH,
        timestamp: request.headers.get(RELAY_TIMESTAMP_HEADER),
        signature: request.headers.get(RELAY_SIGNATURE_HEADER),
        rawBody,
      });
      throw new ApiError(401, "Invalid relay signature", RELAY_ERROR_CODES.invalidSignature);
    }
    const connector: ConnectorRow = found;

    const verdict = verifyRelaySignature({
      secretHash: connector.relay_secret_hash,
      timestamp: request.headers.get(RELAY_TIMESTAMP_HEADER),
      signature: request.headers.get(RELAY_SIGNATURE_HEADER),
      rawBody,
    });
    if (!verdict.ok) {
      // No body, header or secret in the log line — connector id and reason only.
      console.warn("[nopm][lark-relay] rejected relay request", { connector: connector.id, reason: verdict.reason });
      if (verdict.reason === "stale") {
        throw new ApiError(
          401,
          "Relay timestamp is outside the allowed window; check the clock on the machine running the worker",
          RELAY_ERROR_CODES.staleTimestamp,
        );
      }
      if (verdict.reason === "no_secret") {
        throw new ApiError(401, "This connector has no relay secret", RELAY_ERROR_CODES.noSecret);
      }
      throw new ApiError(401, "Invalid relay signature", RELAY_ERROR_CODES.invalidSignature);
    }

    // Authenticated from here: it is now safe to say WHY a connector refuses.
    if (connector.status !== "active") {
      throw new ApiError(403, "Connector is not active", RELAY_ERROR_CODES.inactive);
    }
    if (connector.config.mode !== "long_connection") {
      throw new ApiError(
        403,
        "Connector is not in long-connection mode; switch it to Long connection in Integrations",
        RELAY_ERROR_CODES.wrongMode,
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new ApiError(422, "Relay body is not valid JSON", RELAY_ERROR_CODES.invalidRequest);
    }
    const parsed = relayRequestSchema.safeParse(json);
    if (!parsed.success) {
      return validationError(
        "Validation failed",
        parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
      );
    }
    const req = parsed.data;
    if (req.type !== "ping" && !relayTypeMatchesEvent(req)) {
      throw new ApiError(422, "Relay type does not match the event type", RELAY_ERROR_CODES.invalidRequest);
    }

    const budget = await rateCheck(db, `lark-relay:${connector.id}`, CONNECTOR_RATE_MAX);
    if (!budget.allowed) {
      if (req.type === "card") {
        return NextResponse.json(
          cardCallbackResponse("warning", "Too many requests right now. Try again in a minute, or decide in NoPM."),
          { headers: NO_STORE },
        );
      }
      throw new RateLimitError(`Rate limit exceeded. Retry in ${budget.retryAfterSeconds}s.`);
    }

    if (req.type === "ping") {
      return NextResponse.json(
        { data: { ok: true, connector_id: connector.id, mode: connector.config.mode, status: connector.status } },
        { headers: NO_STORE },
      );
    }

    let bound: ReturnType<typeof productionContext>;
    try {
      // Decrypts the connector's app secret (needed to answer through the bot).
      bound = productionContext(connector);
    } catch {
      console.error("[nopm][lark-relay] connector secrets are unreadable", { connector: connector.id });
      throw new ApiError(503, "Service unavailable", "connector_unavailable");
    }

    const result = await handleLarkPayload(bound.ctx, req.payload, bound.deps);
    return NextResponse.json(result.body ?? {}, { status: result.status, headers: NO_STORE });
  },
  { auth: false },
);

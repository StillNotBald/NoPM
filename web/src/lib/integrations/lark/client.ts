/**
 * Lark / Feishu outbound client — a thin, per-connector wrapper over the
 * official `@larksuiteoapi/node-sdk` (MIT, pinned exactly in package.json).
 *
 * Responsibilities: send an interactive card to a person (`open_id`) or a group
 * (`chat_id`), patch a card that was already sent, check credentials via the
 * bot-info endpoint, and translate every failure into a `DeliverResult` the
 * hub's retry queue can act on. No DB access, no governance decisions.
 *
 * Verified against SDK 1.74.0 (`lib/index.js`, `types/index.d.ts`) by driving a
 * real `Client` with an in-memory HTTP double:
 *   • `Domain.Lark` → https://open.larksuite.com, `Domain.Feishu` →
 *     https://open.feishu.cn.
 *   • `client.im.v1.message.create({ params:{receive_id_type}, data:{receive_id,
 *     msg_type, content, uuid?} })` → POST /open-apis/im/v1/messages; the new
 *     message id is `data.message_id`.
 *   • `client.im.v1.message.patch({ path:{message_id}, data:{content} })` →
 *     PATCH /open-apis/im/v1/messages/:message_id.
 *   • `client.request({ method:"GET", url:"/open-apis/bot/v3/info" })` (the same
 *     call the SDK's own channel uses) → `{ code, bot:{ app_name, open_id } }`.
 *   • The tenant access token is fetched and cached by the SDK keyed by app id.
 *   • Transport failures (HTTP 4xx/5xx) throw an AxiosError; business failures
 *     can also arrive as HTTP 200 with a non-zero `code`. Both are handled.
 * From the official docs (open.feishu.cn): message `uuid` ≤ 50 chars and dedups
 * sends for one hour; card payloads ≤ 30 KB; 429 / code 99991400 carries
 * `x-ogw-ratelimit-reset` (seconds); codes 230020 and 11232 are also frequency
 * limits. Card patch (message-card/patch): PATCH /open-apis/im/v1/messages/:id
 * with `content` = the card JSON string; the original and the replacement must
 * both be shared cards (`config.update_multi:true`, the only mode card JSON 2.0
 * supports); only messages sent within 14 days can be edited (error 230031);
 * 5 QPS per message; scopes im:message / im:message:send_as_bot /
 * im:message:update; the caller must be the sending app; batch-sent or
 * visible-to-some cards cannot be edited. A 2.0 card may only be replaced by a
 * 2.0 card (error 200830 otherwise), which is why every builder emits 2.0.
 *
 * Secrets: the SDK's default logger would print request bodies (which carry
 * single-use action tokens) on failure, so the client is built with a silent
 * logger and errors are summarised here from status/code/msg only — never from
 * `error.config` (which holds the Authorization header).
 */

import { createHash } from "node:crypto";
import type { ConnectorRow, DeliverResult, LarkSecrets, OutboundMessage } from "@/lib/integrations/types";
import { isUpdatableCard } from "./cards";

type Sdk = typeof import("@larksuiteoapi/node-sdk");
type SdkClient = InstanceType<Sdk["Client"]>;
type SdkClientParams = ConstructorParameters<Sdk["Client"]>[0];

let sdkPromise: Promise<Sdk> | null = null;

/** Lazy-load: the SDK bundle is large, and verification-only requests never need it. */
function loadSdk(): Promise<Sdk> {
  sdkPromise ??= import("@larksuiteoapi/node-sdk").then((mod) => {
    const asModule = mod as unknown as Sdk & { default?: Sdk };
    return typeof asModule.Client === "function" ? asModule : (asModule.default as Sdk);
  });
  return sdkPromise;
}

/** Hard ceiling for one platform call (the SDK's default HTTP instance has no timeout). */
export const LARK_CALL_TIMEOUT_MS = 10_000;
/** Platform limit for the message `uuid` (idempotency key). */
export const MAX_UUID_CHARS = 50;
/** Card payload ceiling from the platform docs (30 KB). */
export const MAX_CARD_BYTES = 30 * 1024;

const SILENT_LOGGER = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

/** Raised when the test-only API base override is set to something unsafe. Never retried. */
export class LarkOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LarkOverrideError";
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

/**
 * TEST-ONLY API base override, so the whole emit → send → card path can run
 * against a fake Lark server on this machine.
 *
 *   NOPM_LARK_API_BASE_OVERRIDE=http://127.0.0.1:<port>   (or http://localhost:<port>)
 *
 * Guards, in order:
 *   1. Unset / blank → no override.
 *   2. NODE_ENV === "production" → IGNORED ENTIRELY (even if set to junk),
 *      unless NOPM_ALLOW_LARK_OVERRIDE=1 is also set. A production deployment
 *      that inherits this variable by accident therefore still talks to Lark.
 *   3. Otherwise it must be a bare `http://127.0.0.1[:port]` or
 *      `http://localhost[:port]` origin: no https, no other host (so no
 *      `localhost.evil.test`, no `127.0.0.1@evil.test`), no credentials, path,
 *      query or fragment. Anything else THROWS `LarkOverrideError` (the send
 *      fails permanently) instead of silently falling back to the real
 *      platform: a mistyped override must not send test traffic, or real
 *      credentials, somewhere unexpected.
 * The value is passed to the SDK as `domain`, replacing Domain.Lark/Feishu for
 * every call (tenant token, send, patch, bot info).
 *
 * What the fake server must implement (shapes exactly as the SDK sends and
 * expects them; `{base}` is the override):
 *   POST  {base}/open-apis/auth/v3/tenant_access_token/internal
 *         body  {"app_id","app_secret"}
 *         reply {"code":0,"msg":"ok","tenant_access_token":"t-…","expire":7200}
 *   POST  {base}/open-apis/im/v1/messages?receive_id_type=open_id|chat_id
 *         header Authorization: Bearer <tenant token>
 *         body  {"receive_id","msg_type":"interactive","content":"<card JSON string>","uuid"}
 *         reply {"code":0,"msg":"success","data":{"message_id":"om_…"}}
 *   PATCH {base}/open-apis/im/v1/messages/{message_id}
 *         body  {"content":"<card JSON string>"}
 *         reply {"code":0,"msg":"success","data":{}}
 *   GET   {base}/open-apis/bot/v3/info
 *         reply {"code":0,"msg":"ok","bot":{"app_name":"…","open_id":"ou_…"}}
 * Failures: a non-2xx HTTP status (optionally with an `x-ogw-ratelimit-reset`
 * header) or HTTP 200 with a non-zero `code`; both are classified by
 * `classifyLarkError`.
 */
export function resolveApiBaseOverride(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.NOPM_LARK_API_BASE_OVERRIDE?.trim();
  if (!raw) return null;
  if (env.NODE_ENV === "production" && env.NOPM_ALLOW_LARK_OVERRIDE !== "1") return null;

  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  const safe =
    url !== null &&
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname) &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash;
  if (!url || !safe) {
    throw new LarkOverrideError("NOPM_LARK_API_BASE_OVERRIDE must be a bare http://127.0.0.1 or http://localhost origin");
  }
  return url.origin;
}

export type ClientOverrides = {
  /** Test seam: an HTTP double so no request leaves the process. */
  httpInstance?: SdkClientParams["httpInstance"];
  /** Test seam: isolates the tenant-token cache between tests. */
  cache?: SdkClientParams["cache"];
  /** Test seam (code-level, unlike the env override): point the SDK at a loopback server. */
  domain?: string;
  timeoutMs?: number;
};

type SdkHttp = NonNullable<SdkClientParams["httpInstance"]>;

/**
 * The SDK's default HTTP instance has no timeout: `withTimeout` below only
 * stops US waiting, and the socket stays open until the OS gives up. Wrapping
 * the default instance with an axios `timeout` makes a slow call actually
 * abort (`ECONNABORTED`, classified as a retryable network error). The server
 * may still process a request we gave up on, which is what the per-delivery
 * idempotency key in `sendCard` is for.
 */
export function withRequestTimeout(base: SdkHttp, timeout: number): SdkHttp {
  const bare = (method: "get" | "delete" | "head" | "options") => (url: string, opts?: object) =>
    (base[method] as unknown as (u: string, o: object) => Promise<unknown>)(url, { timeout, ...opts });
  const withBody = (method: "post" | "put" | "patch") => (url: string, data?: unknown, opts?: object) =>
    (base[method] as unknown as (u: string, d: unknown, o: object) => Promise<unknown>)(url, data, { timeout, ...opts });
  return {
    request: (opts: object) => (base.request as unknown as (o: object) => Promise<unknown>)({ timeout, ...opts }),
    get: bare("get"),
    delete: bare("delete"),
    head: bare("head"),
    options: bare("options"),
    post: withBody("post"),
    put: withBody("put"),
    patch: withBody("patch"),
  } as unknown as SdkHttp;
}

/**
 * One tenant-token cache PER CONNECTOR (and per credential pair).
 *
 * The SDK keeps the tenant access token in a cache and, when none is passed,
 * falls back to a process-wide one keyed by `app_id` alone. `app_id` is not a
 * secret (it travels in every event header), and nothing stops two workspaces
 * registering the same one: with the shared cache, a second connector with a
 * WRONG app secret rode the first connector's cached token, so its "Test
 * connection" passed and its sends went out as the first workspace's bot until
 * the token aged out. Keying the cache by connector id plus a hash of the
 * credentials means a token is only ever reused for the credentials that
 * fetched it, and a changed secret starts a clean cache.
 */
const TOKEN_CACHES = new Map<string, InstanceType<Sdk["DefaultCache"]>>();
const MAX_TOKEN_CACHES = 200;

function tokenCacheFor(sdk: Sdk, connector: ConnectorRow, secrets: LarkSecrets): InstanceType<Sdk["DefaultCache"]> {
  const credentials = createHash("sha256").update(`${connector.config.appId}
${secrets.appSecret}`).digest("hex").slice(0, 16);
  const key = `${connector.id}:${credentials}`;
  let cache = TOKEN_CACHES.get(key);
  if (!cache) {
    if (TOKEN_CACHES.size >= MAX_TOKEN_CACHES) {
      const oldest = TOKEN_CACHES.keys().next().value;
      if (oldest !== undefined) TOKEN_CACHES.delete(oldest);
    }
    cache = new sdk.DefaultCache();
    TOKEN_CACHES.set(key, cache);
  }
  return cache;
}

export async function createLarkClient(
  connector: ConnectorRow,
  secrets: LarkSecrets,
  overrides: ClientOverrides = {},
): Promise<SdkClient> {
  const base = overrides.domain ?? resolveApiBaseOverride();
  const sdk = await loadSdk();
  const httpInstance =
    overrides.httpInstance ??
    (sdk.defaultHttpInstance
      ? withRequestTimeout(sdk.defaultHttpInstance as unknown as SdkHttp, overrides.timeoutMs ?? LARK_CALL_TIMEOUT_MS)
      : undefined);
  return new sdk.Client({
    appId: connector.config.appId,
    appSecret: secrets.appSecret,
    domain: base ?? (connector.config.region === "feishu" ? sdk.Domain.Feishu : sdk.Domain.Lark),
    loggerLevel: sdk.LoggerLevel.fatal,
    logger: SILENT_LOGGER,
    source: "nopm",
    ...(httpInstance ? { httpInstance } : {}),
    cache: overrides.cache ?? tokenCacheFor(sdk, connector, secrets),
  });
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/** Frequency-limit business codes (docs: frequency-control + message create). */
const RATE_LIMIT_CODES = new Set([
  99991400, // request trigger frequency limit
  230020, // IM frequency limit
  11232, // IM on-the-hour / half-hour load shedding
]);
/** tenant_access_token invalid/expired: a re-fetch fixes it once the cached token ages out. */
const TOKEN_EXPIRED_CODE = 99991663;

/**
 * Permanent failures worth naming. None of these are retried: the retry queue
 * would only repeat the same refusal (docs: im-v1 message create / patch tables).
 */
const PERMANENT_HINTS: Record<number, string> = {
  230031: "edit window expired: Lark only allows editing a card for 14 days after it was sent",
  230011: "message was recalled",
  230110: "message was deleted",
  232009: "chat was dissolved",
  230013: "recipient is outside the app's availability scope",
  230002: "bot is not in the chat",
  230006: "bot capability is not enabled",
  230027: "app lacks a required permission",
  230099: "card content was rejected",
};

const RETRYABLE_NETWORK = new Set(["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EPIPE"]);

type ErrorShape = {
  message?: unknown;
  code?: unknown;
  response?: { status?: unknown; data?: unknown; headers?: unknown };
};

function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== "object") return null;
  const bag = headers as { get?: (n: string) => unknown } & Record<string, unknown>;
  const direct = typeof bag.get === "function" ? bag.get(name) : undefined;
  const value = direct ?? bag[name];
  return value === undefined || value === null ? null : String(value);
}

function clip(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Turn anything the SDK/axios can throw into a safe `DeliverResult` failure.
 * The message is assembled from status / code / msg only.
 */
export function classifyLarkError(err: unknown): Extract<DeliverResult, { ok: false }> {
  if (err instanceof LarkOverrideError) return { ok: false, retryable: false, error: err.message };
  const e = (err && typeof err === "object" ? err : {}) as ErrorShape;
  const status = typeof e.response?.status === "number" ? e.response.status : null;
  const data = e.response?.data && typeof e.response.data === "object" ? (e.response.data as { code?: unknown; msg?: unknown }) : null;
  const code = typeof data?.code === "number" ? data.code : null;
  const msg = typeof data?.msg === "string" ? data.msg : null;
  const reset = headerValue(e.response?.headers, "x-ogw-ratelimit-reset");

  if (status === 429 || (code !== null && RATE_LIMIT_CODES.has(code))) {
    const wait = reset && /^\d+$/.test(reset) ? ` (retry after ${reset}s)` : "";
    return { ok: false, retryable: true, error: clip(`rate limited${wait}${code ? ` [lark ${code}]` : ""}`) };
  }
  if (status !== null || code !== null) {
    const retryable = (status !== null && status >= 500) || code === TOKEN_EXPIRED_CODE;
    const hint = code !== null ? PERMANENT_HINTS[code] : undefined;
    return {
      ok: false,
      retryable,
      error: clip(`lark ${code ?? status}${hint ? ` (${hint})` : ""}${msg ? `: ${msg}` : ""}`),
    };
  }

  const text = typeof e.message === "string" ? e.message : "";
  // The SDK's token manager throws `failed to get tenant_access_token, code: N, msg: …`
  // when the app id/secret are rejected: retrying cannot help.
  if (/failed to get (tenant_access_token|app_access_token)/i.test(text)) {
    return { ok: false, retryable: false, error: clip(`credentials rejected: ${text}`) };
  }
  const netCode = typeof e.code === "string" ? e.code : "";
  if (RETRYABLE_NETWORK.has(netCode) || /timeout|timed out|network/i.test(text)) {
    return { ok: false, retryable: true, error: clip(`network error${netCode ? ` [${netCode}]` : ""}`) };
  }
  // Unknown thrown error: bounded retry beats silently dropping an approval card.
  return { ok: false, retryable: true, error: clip(`unexpected error${text ? `: ${text}` : ""}`) };
}

function interpretBody(res: unknown): { ok: true; messageId: string | null } | Extract<DeliverResult, { ok: false }> {
  const body = (res && typeof res === "object" ? res : {}) as { code?: unknown; msg?: unknown; data?: { message_id?: unknown } };
  if (typeof body.code === "number" && body.code !== 0) {
    return classifyLarkError({ response: { status: 200, data: { code: body.code, msg: body.msg } } });
  }
  const id = body.data?.message_id;
  return { ok: true, messageId: typeof id === "string" && id ? id : null };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("request timeout"), { code: "ETIMEDOUT" })), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Send an interactive card. The platform deduplicates sends that carry the same
 * `uuid` for an hour, so the key is what makes a retry safe: when the first
 * attempt landed but the response was lost (a timeout, a dropped connection),
 * the retry returns the original message instead of creating a second card.
 *
 * The hub passes the DELIVERY id as `msg.idempotencyKey`: stable across every
 * attempt of one delivery, and independent of the card content. A key derived
 * from the content is not safe for cards, because content can legitimately
 * differ between attempts and then every retry looks like a new message. The
 * content-derived fallback is only for callers with no delivery row (an
 * immediate bot reply), where an identical reply to the same person inside an
 * hour is rightly collapsed.
 */
export async function sendCard(
  connector: ConnectorRow,
  secrets: LarkSecrets,
  msg: OutboundMessage,
  overrides: ClientOverrides = {},
): Promise<DeliverResult> {
  const content = JSON.stringify(msg.body);
  if (Buffer.byteLength(content, "utf8") > MAX_CARD_BYTES) {
    return { ok: false, retryable: false, error: "card exceeds the 30 KB platform limit" };
  }
  const uuid = (msg.idempotencyKey?.trim() ||
    createHash("sha256").update(`${msg.receiveIdType}:${msg.receiveId}:${content}`).digest("hex")
  ).slice(0, MAX_UUID_CHARS);
  try {
    const client = await createLarkClient(connector, secrets, overrides);
    const res = await withTimeout(
      client.im.v1.message.create({
        params: { receive_id_type: msg.receiveIdType },
        data: { receive_id: msg.receiveId, msg_type: "interactive", content, uuid },
      }),
      overrides.timeoutMs ?? LARK_CALL_TIMEOUT_MS,
    );
    const parsed = interpretBody(res);
    return parsed.ok ? { ok: true, externalMessageId: parsed.messageId } : parsed;
  } catch (err) {
    return classifyLarkError(err);
  }
}

/**
 * Replace the content of a card that was sent earlier.
 *
 * Platform rules (docs, message-card/patch): the original AND the replacement
 * must be shared cards (`config.update_multi:true`; JSON 2.0 only supports
 * shared cards), the message must be ≤ 14 days old, the caller must be the app
 * that sent it, and a message can be edited ~5 times a second. Failures that no
 * retry can fix (edit window expired = 230031, recalled = 230011, deleted =
 * 230110, a card that is not updatable) come back `retryable:false`; rate limits
 * and 5xx come back `retryable:true`.
 */
export async function patchCard(
  connector: ConnectorRow,
  secrets: LarkSecrets,
  externalMessageId: string,
  body: Record<string, unknown>,
  overrides: ClientOverrides = {},
): Promise<DeliverResult> {
  if (!isUpdatableCard(body)) {
    return { ok: false, retryable: false, error: "card is not updatable (config.update_multi must be true)" };
  }
  const content = JSON.stringify(body);
  if (Buffer.byteLength(content, "utf8") > MAX_CARD_BYTES) {
    return { ok: false, retryable: false, error: "card exceeds the 30 KB platform limit" };
  }
  try {
    const client = await createLarkClient(connector, secrets, overrides);
    const res = await withTimeout(
      client.im.v1.message.patch({ path: { message_id: externalMessageId }, data: { content } }),
      overrides.timeoutMs ?? LARK_CALL_TIMEOUT_MS,
    );
    const parsed = interpretBody(res);
    return parsed.ok ? { ok: true, externalMessageId } : parsed;
  } catch (err) {
    return classifyLarkError(err);
  }
}

/**
 * Cheap credential check: fetching the tenant token proves app id + secret, and
 * the bot-info call proves the Bot capability is enabled and published.
 */
export async function testBot(
  connector: ConnectorRow,
  secrets: LarkSecrets,
  overrides: ClientOverrides = {},
): Promise<{ ok: true; botName: string | null } | { ok: false; error: string }> {
  try {
    const client = await createLarkClient(connector, secrets, overrides);
    const res = (await withTimeout(
      client.request({ method: "GET", url: "/open-apis/bot/v3/info" }),
      overrides.timeoutMs ?? LARK_CALL_TIMEOUT_MS,
    )) as { code?: unknown; msg?: unknown; bot?: { app_name?: unknown } };
    if (typeof res?.code === "number" && res.code !== 0) {
      return { ok: false, error: clip(`lark ${res.code}${typeof res.msg === "string" ? `: ${res.msg}` : ""}`) };
    }
    if (!res?.bot) return { ok: false, error: "bot capability is not enabled for this app" };
    return { ok: true, botName: typeof res.bot.app_name === "string" ? res.bot.app_name : null };
  } catch (err) {
    return { ok: false, error: classifyLarkError(err).error };
  }
}

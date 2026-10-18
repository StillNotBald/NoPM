#!/usr/bin/env node
/**
 * NoPM Lark / Feishu long-connection worker (2026-10-16, PLAN.md D5).
 *
 * WHY: a self-hosted NoPM usually has no public URL, so Lark cannot call its
 * webhook routes. Lark's long-connection mode flips the direction: this
 * process opens an OUTBOUND WebSocket to Lark (self-built apps only) and
 * receives message events and card button clicks over it. Each one is then
 * RELAYED to the NoPM app as an HMAC-signed POST
 *     {NOPM_APP_URL}/api/integrations/lark/{NOPM_LARK_CONNECTOR_ID}/relay
 * so the governed inbound pipeline (identity link, four-eyes, one audit row,
 * channel "lark") exists exactly once and serves both transports. This script
 * decides nothing and stores nothing: NoPM stays the system of record, Lark
 * only renders cards and relays clicks.
 *
 * RUN EXACTLY ONE INSTANCE PER LARK APP. Lark delivers each event to ONE
 * randomly chosen connected client ("cluster mode"), so two workers would each
 * see roughly half of the clicks and the other half would land on a process
 * that may be down or misconfigured. This script refuses to start a second
 * copy on the same machine (lock file) but cannot see other machines - that is
 * on the operator. Do not run it on a serverless host.
 *
 * Zero build: plain ESM, no dependency other than the pinned
 * `@larksuiteoapi/node-sdk`. The relay signing logic below is deliberately
 * duplicated from src/lib/integrations/lark/relay.ts so this file can be
 * copied onto any box by itself; relay.test.ts asserts both stay byte-identical.
 *
 * Environment:
 *   LARK_APP_ID               cli_... (Lark developer console > Credentials)
 *   LARK_APP_SECRET           app secret (never logged)
 *   LARK_REGION               "lark" (international) | "feishu" (China)
 *   NOPM_APP_URL              base URL of your NoPM, e.g. https://nopm.example.com
 *   NOPM_LARK_CONNECTOR_ID    connector id shown in NoPM > Integrations
 *   NOPM_LARK_RELAY_SECRET    relay secret shown ONCE when the connector was created
 *   LARK_LOG_LEVEL            optional: error | warn (default) | info. Never debug:
 *                             the SDK's debug logs contain event bodies and tickets.
 *   NOPM_LARK_RELAY_TIMEOUT_MS  optional: 500-2800 (default 2500). Lark gives a
 *                             card click 3 s in total.
 *   NOPM_LARK_ALLOW_MULTI     optional: "1" skips the same-machine lock.
 *
 * Exit codes: 0 clean shutdown | 1 runtime failure (restart me) |
 *             2 configuration or credential error (do NOT auto-restart) |
 *             3 another worker is running on this machine.
 */

import { createHash, createHmac } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const WORKER_NAME = "nopm-lark-worker";
export const SDK_VERSION_EXPECTED = "1.74.0";
export const CARD_ACTION_EVENT_TYPE = "card.action.trigger";
export const MESSAGE_EVENT_TYPE = "im.message.receive_v1";

const RELAY_TIMESTAMP_HEADER = "x-nopm-relay-timestamp";
const RELAY_SIGNATURE_HEADER = "x-nopm-relay-signature";

/* ------------------------------------------------------------------ signing */

/** Lowercase hex SHA-256 of the raw relay secret = the server's stored `relay_secret_hash` = the HMAC key. */
export function hashRelaySecret(rawSecret) {
  return createHash("sha256").update(rawSecret).digest("hex");
}

/** `v1=<hex(hmac_sha256(sha256hex(secret), timestamp + "." + body))>` */
export function signRelayBody(secretHash, timestamp, rawBody) {
  return `v1=${createHmac("sha256", secretHash).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function buildRelayHeaders(rawSecret, rawBody, nowMs = Date.now()) {
  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    [RELAY_TIMESTAMP_HEADER]: timestamp,
    [RELAY_SIGNATURE_HEADER]: signRelayBody(hashRelaySecret(rawSecret), timestamp, rawBody),
  };
}

/* ------------------------------------------------------------------- config */

const APP_ID_RE = /^cli_[0-9a-fA-F]{16}$/; // the SDK silently refuses to start on anything else
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOG_LEVELS = ["error", "warn", "info"];

/**
 * Hosts where plain http is acceptable: loopback, private ranges, single-label
 * names (a Docker/Compose service name like `web` cannot be a public DNS name)
 * and the conventional internal suffixes. Anything else gets a warning.
 */
export function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "[::1]" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (!h.includes(".") && !h.startsWith("[")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Validate the environment. Returns every problem at once (an operator should
 * not have to fix them one restart at a time) and NEVER echoes a value - only
 * the variable name - so a mistyped secret cannot leak into a log.
 */
export function loadConfig(env) {
  const errors = [];
  const warnings = [];
  const get = (name) => (typeof env[name] === "string" ? env[name].trim() : "");

  const appId = get("LARK_APP_ID");
  if (!appId) errors.push("LARK_APP_ID is required (looks like cli_a1b2c3d4e5f6a7b8).");
  else if (!APP_ID_RE.test(appId)) errors.push("LARK_APP_ID must look like cli_ followed by 16 hex characters.");

  const appSecret = get("LARK_APP_SECRET");
  if (!appSecret) errors.push("LARK_APP_SECRET is required.");

  const region = get("LARK_REGION").toLowerCase();
  if (region !== "lark" && region !== "feishu") {
    errors.push('LARK_REGION must be "lark" (international) or "feishu" (China). It must match where the app was created.');
  }

  let appUrl = "";
  const rawUrl = get("NOPM_APP_URL");
  if (!rawUrl) {
    errors.push("NOPM_APP_URL is required, e.g. https://nopm.example.com");
  } else {
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocol");
      appUrl = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
      if (u.protocol === "http:" && !isPrivateHost(u.hostname)) {
        warnings.push("NOPM_APP_URL is plain http on a non-local host: relayed chat text travels unencrypted. Use https.");
      }
    } catch {
      errors.push("NOPM_APP_URL must be an http(s) URL.");
    }
  }

  const connectorId = get("NOPM_LARK_CONNECTOR_ID");
  if (!connectorId) errors.push("NOPM_LARK_CONNECTOR_ID is required (NoPM > Integrations).");
  else if (!UUID_RE.test(connectorId)) errors.push("NOPM_LARK_CONNECTOR_ID must be a UUID.");

  const relaySecret = get("NOPM_LARK_RELAY_SECRET");
  if (!relaySecret) errors.push("NOPM_LARK_RELAY_SECRET is required (shown once when the connector was created).");
  else if (relaySecret.length < 16) errors.push("NOPM_LARK_RELAY_SECRET is too short to be the value NoPM issued.");

  const logLevel = (get("LARK_LOG_LEVEL") || "warn").toLowerCase();
  if (!LOG_LEVELS.includes(logLevel)) {
    errors.push("LARK_LOG_LEVEL must be error, warn or info (debug is refused: the SDK's debug output contains message bodies).");
  }

  let timeoutMs = 2500;
  if (get("NOPM_LARK_RELAY_TIMEOUT_MS")) {
    const n = Number(get("NOPM_LARK_RELAY_TIMEOUT_MS"));
    if (!Number.isInteger(n) || n < 500 || n > 2800) {
      errors.push("NOPM_LARK_RELAY_TIMEOUT_MS must be an integer between 500 and 2800 (Lark allows 3000 ms in total).");
    } else {
      timeoutMs = n;
    }
  }

  if (errors.length) return { ok: false, errors, warnings };
  return {
    ok: true,
    warnings,
    config: {
      appId,
      appSecret,
      region,
      appUrl,
      connectorId,
      relaySecret,
      relayUrl: `${appUrl}/api/integrations/lark/${connectorId}/relay`,
      logLevel,
      timeoutMs,
      allowMulti: get("NOPM_LARK_ALLOW_MULTI") === "1",
    },
  };
}

/* ----------------------------------------------------------------- logging */

/**
 * The only place this process writes. Callers pass fixed message strings plus
 * a few scalar fields (event type, status, duration). Message text, card
 * payloads, headers, secrets and URLs-with-tickets never reach this function.
 */
export function createLogger(sink = console) {
  const emit = (level, message, fields) => {
    const tail = fields
      ? " " + Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(" ")
      : "";
    const line = `${new Date().toISOString()} [${WORKER_NAME}] ${level} ${message}${tail}`;
    (level === "error" ? sink.error : level === "warn" ? sink.warn : sink.log).call(sink, line);
  };
  return {
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

/* ---------------------------------------------------------------- envelope */

/**
 * The SDK's EventDispatcher hands handlers a FLATTENED object
 * `{ schema, ...header, ...event }` (see RequestHandle.parse in the SDK). The
 * hosted webhook routes receive the real v2 envelope `{ schema, header, event }`,
 * and the NoPM handlers expect that one shape on both transports, so rebuild it.
 *
 * `token` is the one collision: header.token is the app's verification token
 * (a credential - NOT forwarded, NoPM holds its own copy) while a card
 * callback's event.token is the card's delayed-update credential, and the SDK
 * merge lets the event's win. So for card callbacks `token` goes back under
 * `event`, and for every other event it is dropped.
 */
export function toEnvelope(flat) {
  const HEADER_KEYS = ["event_id", "event_type", "create_time", "app_id", "tenant_key"];
  const src = flat ?? {};
  const header = {};
  const event = {};
  // Object.keys, not rest-spread: the SDK tags its flattened object with an
  // own Symbol key (its internal event-type marker) that a spread would copy.
  for (const key of Object.keys(src)) {
    if (key === "schema" || key === "token") continue;
    (HEADER_KEYS.includes(key) ? header : event)[key] = src[key];
  }
  if (src.event_type === CARD_ACTION_EVENT_TYPE && src.token !== undefined) event.token = src.token;
  return { schema: typeof src.schema === "string" ? src.schema : "2.0", header, event };
}

/* --------------------------------------------------------------- seen cache */

/**
 * Remembers event ids that were relayed SUCCESSFULLY so a Lark re-push (it
 * retries when we are slow) does not post the same chat reply twice. Only
 * successes are remembered, so a failed relay can still be retried. This is a
 * courtesy; the real replay protection is server-side (idempotent inbound
 * actions, single-use tokens and link codes).
 */
export function createSeenCache({ ttlMs = 10 * 60 * 1000, max = 2000, now = Date.now } = {}) {
  const seen = new Map();
  const sweep = () => {
    const t = now();
    for (const [k, exp] of seen) if (exp <= t) seen.delete(k);
    while (seen.size > max) seen.delete(seen.keys().next().value);
  };
  return {
    has(id) {
      if (!id) return false;
      const exp = seen.get(id);
      if (exp === undefined) return false;
      if (exp <= now()) {
        seen.delete(id);
        return false;
      }
      return true;
    },
    add(id) {
      if (!id) return;
      seen.set(id, now() + ttlMs);
      sweep();
    },
    get size() {
      return seen.size;
    },
  };
}

/* ------------------------------------------------------------------- relay */

export class RelayError extends Error {
  constructor(message, { status = 0, code, retryable = false } = {}) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Operator-facing explanation for a relay failure. Fixed strings only. */
export function describeRelayFailure(status, code) {
  if (status === 401 && code === "no_relay_secret") {
    return "This connector has no relay secret (it was created for webhook mode). Create a connector in Long connection mode in NoPM > Integrations and use its id and secret.";
  }
  if (status === 401 && code === "stale_relay_timestamp") {
    return "NoPM says this machine's clock is more than 5 minutes off. Fix the system time (NTP) and restart.";
  }
  if (status === 401) {
    return "NoPM rejected the relay signature: NOPM_LARK_RELAY_SECRET is wrong, or this machine's clock is more than 5 minutes off.";
  }
  if (status === 403 && code === "wrong_mode") {
    return "This connector is not in long-connection mode. In NoPM > Integrations, switch it to Long connection (self-host).";
  }
  if (status === 403 && code === "connector_inactive") {
    return "This connector is paused or revoked in NoPM. Resume it in Integrations, or create a new connector.";
  }
  if (status === 404) {
    return "NoPM has no Lark connector with this id. Check NOPM_LARK_CONNECTOR_ID and NOPM_APP_URL.";
  }
  if (status === 429) return "NoPM rate-limited the relay (429).";
  if (status >= 500) return `NoPM answered ${status}.`;
  if (status === 0) return "Could not reach NoPM (network error or timeout).";
  return `NoPM rejected the relay request (${status}${code ? ` ${code}` : ""}).`;
}

/**
 * POST one signed relay call. Resolves `{ status, json }` on 2xx, otherwise
 * throws RelayError (never carrying the response body or request payload).
 * `redirect: "error"`: a 307/308 would re-POST the signed body to wherever the
 * redirect points, which is never what a pinned NOPM_APP_URL intends.
 */
export async function relay(cfg, type, payload, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const nowMs = deps.now ? deps.now() : Date.now();
  const body = JSON.stringify(payload === undefined ? { type } : { type, payload });
  let res;
  try {
    res = await fetchImpl(cfg.relayUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": `${WORKER_NAME}/1`,
        ...buildRelayHeaders(cfg.relaySecret, body, nowMs),
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    // err.name is "TimeoutError" / "TypeError" - safe; err.message of a fetch failure can embed the URL, so drop it.
    throw new RelayError(describeRelayFailure(0), { status: 0, code: err?.name === "TimeoutError" ? "timeout" : "network", retryable: true });
  }

  if (res.status >= 200 && res.status < 300) {
    let json = {};
    try {
      const parsed = await res.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed;
    } catch {
      /* empty or non-JSON 2xx body: treat as {} */
    }
    return { status: res.status, json };
  }

  let code;
  try {
    const parsed = await res.json();
    if (parsed && typeof parsed.code === "string" && /^[a-z_]{1,40}$/.test(parsed.code)) code = parsed.code;
  } catch {
    /* ignore */
  }
  throw new RelayError(describeRelayFailure(res.status, code), {
    status: res.status,
    code,
    retryable: res.status === 429 || res.status >= 500,
  });
}

/* ---------------------------------------------------------- Lark callbacks */

/** What a card click shows when NoPM could not be reached in time. Fixed copy, no detail. */
export function failureToast(err) {
  const content =
    err instanceof RelayError && err.status === 0
      ? "NoPM did not answer in time. Check the Approvals page in NoPM before trying again."
      : "NoPM could not process this click. Open the request in NoPM to decide it there.";
  return { toast: { type: "error", content } };
}

/**
 * Build the two callbacks the SDK dispatcher calls. Whatever the card handler
 * RETURNS is sent straight back to Lark as the callback response (toast and/or
 * replacement card), which is exactly the JSON the NoPM relay route returns.
 */
export function createHandlers({ cfg, log, seen, track = (p) => p, deps = {} }) {
  return {
    [MESSAGE_EVENT_TYPE]: (flat) =>
      track(
        (async () => {
          const envelope = toEnvelope(flat);
          // Dedupe on the MESSAGE id: Lark re-pushes an unacknowledged message under a new event id.
          const eventId = envelope.event?.message?.message_id || envelope.header.event_id;
          if (seen.has(eventId)) return undefined;
          try {
            const started = Date.now();
            const { status } = await relay(cfg, "event", envelope, deps);
            seen.add(eventId);
            log.info("relayed event", { type: MESSAGE_EVENT_TYPE, status, ms: Date.now() - started });
          } catch (err) {
            log.warn("event relay failed", { type: MESSAGE_EVENT_TYPE, status: err.status, code: err.code, retryable: err.retryable });
            // Retryable: throw, so the SDK answers Lark with a 500 and Lark re-pushes (NoPM dedupes by message id).
            // Not retryable (bad config / rejected): swallow, a re-push would fail identically.
            if (err.retryable) throw err;
          }
          return undefined;
        })(),
      ),

    [CARD_ACTION_EVENT_TYPE]: (flat) =>
      track(
        (async () => {
          const envelope = toEnvelope(flat);
          try {
            const started = Date.now();
            const { status, json } = await relay(cfg, "card", envelope, deps);
            log.info("relayed card click", { type: CARD_ACTION_EVENT_TYPE, status, ms: Date.now() - started });
            return Object.keys(json).length ? json : undefined;
          } catch (err) {
            log.warn("card relay failed", { type: CARD_ACTION_EVENT_TYPE, status: err.status, code: err.code });
            return failureToast(err);
          }
        })(),
      ),
  };
}

/* ------------------------------------------------------------ frame probe */

/**
 * LOG-ONLY probe. SDK 1.74.0 silently drops every WebSocket data frame whose
 * `type` header is not "event", and the docs do not say which type a card click
 * arrives as. If a live click is dropped, this is the line that says so, with the
 * frame type and nothing else (never the payload or any other header). The frame
 * is always handed to the SDK untouched.
 *
 * It wraps the SDK's private `handleEventData`, which is acceptable only because
 * the SDK is pinned to exactly one version: re-check this on every SDK bump (the
 * test file asserts the method still exists).
 */
export function installFrameProbe(ws, log) {
  const original = typeof ws?.handleEventData === "function" ? ws.handleEventData.bind(ws) : null;
  if (!original) return false;
  ws.handleEventData = (frame) => {
    const type = Array.isArray(frame?.headers) ? frame.headers.find((h) => h?.key === "type")?.value : undefined;
    if (type && type !== "event") log.warn("ws frame with a non-event type received (the SDK ignores it)", { type });
    return original(frame);
  };
  return true;
}

/* -------------------------------------------------------- single instance */

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM"; // exists but not ours to signal
  }
}

/**
 * Same-machine single-instance guard (exclusive-create PID file). Lark's
 * cluster mode makes a second listener harmful, but only the operator can stop
 * a second MACHINE; this just stops the common `pm2 start` twice mistake.
 */
export function acquireLock(connectorId, { dir = tmpdir(), pid = process.pid, isAlive = defaultIsAlive } = {}) {
  const file = join(dir, `${WORKER_NAME}-${connectorId}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, String(pid));
      closeSync(fd);
      return { ok: true, file, release: () => { try { unlinkSync(file); } catch { /* already gone */ } } };
    } catch (err) {
      if (err?.code !== "EEXIST") {
        // Read-only or exotic filesystem: do not block the worker on a courtesy lock.
        return { ok: true, file, unlocked: true, release: () => {} };
      }
      let other = 0;
      try { other = Number(readFileSync(file, "utf8").trim()); } catch { /* raced away */ }
      if (other && other !== pid && isAlive(other)) return { ok: false, file, pid: other };
      try { unlinkSync(file); } catch { /* stale cleanup raced */ }
    }
  }
  return { ok: false, file, pid: null };
}

/* ----------------------------------------------------------- Lark failures */

/**
 * The SDK reports a permanent connect failure as `pullConnectConfig failed:
 * code=<n>, msg=<text>` (see WSClient.pullConnectConfig). A rejected credential
 * will never fix itself, so it exits 2 ("do not auto-restart") rather than 1:
 * a supervisor looping on a wrong secret would hammer the platform forever.
 */
export function classifyLarkFailure(message) {
  const code = Number(/code=(\d+)/.exec(String(message ?? ""))?.[1]);
  if (code === 514 || code === 403) {
    return {
      exitCode: 2,
      hint: "Lark rejected the app credentials. Check LARK_APP_ID, LARK_APP_SECRET and LARK_REGION (a Feishu app on the Lark region, or the reverse, fails like this), and that the app is released.",
    };
  }
  if (code === 1000040350) {
    return {
      exitCode: 2,
      hint: "Lark says this app has too many open connections. Another worker (possibly on another machine) is connected. Run exactly one.",
    };
  }
  return { exitCode: 1, hint: null };
}

/* -------------------------------------------------------------------- main */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Signed no-op against the relay: proves URL, connector id, secret and mode BEFORE connecting to Lark. */
export async function preflight(cfg, log, deps = {}) {
  const delays = deps.delays ?? [0, 2000, 4000, 8000, 15000, 30000];
  let last;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await (deps.sleep ?? sleep)(delays[i]);
    try {
      await relay(cfg, "ping", undefined, deps);
      log.info("relay check ok", { connector: cfg.connectorId });
      return { ok: true };
    } catch (err) {
      last = err;
      if (!err.retryable) return { ok: false, error: err, fatal: true };
      log.warn("relay check failed, retrying", { attempt: i + 1, status: err.status, code: err.code });
    }
  }
  return { ok: false, error: last, fatal: false };
}

async function loadSdk() {
  const mod = await import("@larksuiteoapi/node-sdk");
  return mod.WSClient ? mod : mod.default;
}

export async function main(env = process.env) {
  const log = createLogger();
  const parsed = loadConfig(env);
  if (!parsed.ok) {
    for (const e of parsed.errors) log.error(`config: ${e}`);
    return 2;
  }
  const { config: cfg } = parsed;
  for (const w of parsed.warnings) log.warn(`config: ${w}`);

  log.info("starting", { region: cfg.region, app: cfg.appId, connector: cfg.connectorId, relay: new URL(cfg.relayUrl).origin });
  log.warn("single instance only: Lark delivers each event to ONE random connected client. Never run a second worker for this app on any machine.");

  const lock = cfg.allowMulti ? { ok: true, release: () => {} } : acquireLock(cfg.connectorId);
  if (!lock.ok) {
    log.error(`another worker for this connector is already running${lock.pid ? ` (pid ${lock.pid})` : ""}. Lock file: ${lock.file}. If that is stale, delete it.`);
    return 3;
  }
  if (lock.unlocked) log.warn("could not create the single-instance lock file (read-only temp dir?). Continuing without it.");

  const pre = await preflight(cfg, log);
  if (!pre.ok) {
    log.error(pre.error?.message ?? "relay check failed");
    lock.release();
    return pre.fatal ? 2 : 1;
  }

  let Lark;
  try {
    Lark = await loadSdk();
  } catch {
    log.error(`@larksuiteoapi/node-sdk is not installed. Run: npm install @larksuiteoapi/node-sdk@${SDK_VERSION_EXPECTED}`);
    lock.release();
    return 2;
  }

  const sdkLevel = { error: Lark.LoggerLevel.error, warn: Lark.LoggerLevel.warn, info: Lark.LoggerLevel.info }[cfg.logLevel];
  const seen = createSeenCache();
  let inflight = 0;
  const idle = [];
  const track = (p) => {
    inflight++;
    const done = () => { if (--inflight === 0) idle.splice(0).forEach((r) => r()); };
    p.then(done, done);
    return p;
  };

  const dispatcher = new Lark.EventDispatcher({ loggerLevel: sdkLevel }).register(createHandlers({ cfg, log, seen, track }));

  let finish;
  const exited = new Promise((resolve) => { finish = resolve; });
  let stopping = false;
  let ws;

  const stop = async (reason, code) => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { reason });
    try { ws?.close({ force: false }); } catch { /* best effort */ }
    if (inflight > 0) {
      await Promise.race([new Promise((r) => idle.push(r)), sleep(5000)]);
    }
    lock.release();
    finish(code);
  };

  ws = new Lark.WSClient({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    domain: cfg.region === "feishu" ? Lark.Domain.Feishu : Lark.Domain.Lark,
    loggerLevel: sdkLevel,
    autoReconnect: true,
    onReady: () => log.info("connected to Lark", { region: cfg.region }),
    onReconnecting: () => log.warn("connection to Lark lost, reconnecting"),
    onReconnected: () => log.info("reconnected to Lark"),
    onError: (err) => {
      // The SDK only calls this when it has given up (bad credentials, app not in
      // long-connection mode, retries exhausted). err.message is the SDK's own
      // short reason (code + msg); it never carries the secret.
      const { exitCode, hint } = classifyLarkFailure(err?.message);
      log.error(`Lark connection failed permanently: ${err?.message ?? "unknown"}`);
      if (hint) log.error(hint);
      void stop("lark-error", exitCode);
    },
  });

  installFrameProbe(ws, log);

  process.once("SIGINT", () => void stop("SIGINT", 0));
  process.once("SIGTERM", () => void stop("SIGTERM", 0));
  process.on("unhandledRejection", (reason) => {
    log.error(`unhandled rejection: ${reason instanceof Error ? reason.name : typeof reason}`);
    void stop("unhandled-rejection", 1);
  });
  process.on("uncaughtException", (err) => {
    log.error(`uncaught exception: ${err?.name ?? "Error"}`);
    void stop("uncaught-exception", 1);
  });

  // The SDK reports a permanent failure through onError; this is the backstop
  // for the case where it flips to "failed" without that callback firing.
  const watchdog = setInterval(() => {
    if (ws.getConnectionStatus?.().state === "failed") {
      log.error("Lark connection is in failed state");
      void stop("watchdog", 1);
    }
  }, 60_000);
  watchdog.unref();

  await ws.start({ eventDispatcher: dispatcher });
  const code = await exited;
  clearInterval(watchdog);
  return code;
}

// Tests import this module for its pure helpers and must not open a socket.
// (An env flag, not an `import.meta.url === argv[1]` check: process managers
// such as pm2 load the script through a wrapper, which breaks that check.)
if (!process.env.NOPM_LARK_WORKER_IMPORT_ONLY) {
  // Set exitCode and let stdout drain; the unref'd timer is only a backstop
  // for a stray handle keeping the loop alive after a clean stop.
  const exitWith = (code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 1000).unref();
  };
  main().then(exitWith, (err) => {
    console.error(`${new Date().toISOString()} [${WORKER_NAME}] error fatal: ${err?.name ?? "Error"}`);
    exitWith(1);
  });
}

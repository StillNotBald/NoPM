// NoPM local-DB probes — a fake Lark/Feishu OPEN API server (loopback only).
//
// Lets the REAL outbound path run end to end without ever reaching a real Lark
// host: the app is started with
//
//     NOPM_LARK_API_BASE_OVERRIDE=http://127.0.0.1:18080
//
// (test-only env, localhost http URLs only), which makes the official SDK
// client in src/lib/integrations/lark/client.ts talk to this server. It
// implements exactly what that client calls, with the envelopes the SDK expects
// ({ code: 0, msg, data }), checked against @larksuiteoapi/node-sdk 1.74.0:
//
//   POST   /open-apis/auth/v3/tenant_access_token/internal  -> { code, msg, tenant_access_token, expire }
//   GET    /open-apis/bot/v3/info                           -> { code, msg, bot: { app_name, open_id, ... } }
//   POST   /open-apis/im/v1/messages?receive_id_type=...    -> { code, msg, data: { message_id, ... } }
//   PATCH  /open-apis/im/v1/messages/:message_id            -> { code, msg, data: {} }   (PUT is accepted too)
//
// It is deliberately a little stricter than a permissive stub, so a mistake in
// the app shows up here instead of on a real tenant:
//   - IM calls need the bearer token this server issued (proves the SDK fetched one)
//   - a card must be schema 2.0 with unique element ids; violations are recorded
//     and exposed at /__violations (the probe asserts the list is empty)
//   - a card can only be patched if it was sent with config.update_multi=true
//   - a repeated `uuid` returns the original message (the platform dedups for an hour)
//   - any endpoint the app was not expected to call is answered 404 and listed at
//     /__unsupported
//
// Test controls (for the probe):
//   GET  /__health        liveness
//   GET  /__sent          every card sent, in order ({ seq, message_id, receive_id_type, receive_id, uuid, card })
//   GET  /__patched       every patch applied ({ seq, message_id, card })
//   GET  /__calls         per-endpoint call counters
//   GET  /__violations    structural problems found in cards
//   GET  /__unsupported   requests that matched no implemented endpoint
//   POST /__reset         clear all recorded state
//
// Run standalone:  node scripts/local-db/fake-lark.mjs        (port: FAKE_LARK_PORT, default 18080)
// or in-process:   import { startFakeLark } from "./fake-lark.mjs"
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const MAX_BODY = 1024 * 1024;
const MAX_CARD_BYTES = 30 * 1024; // platform limit for a card payload

function envelope(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

/** Structural problems a real tenant would reject (Card JSON 2.0). */
export function cardViolations(card) {
  const problems = [];
  if (!card || typeof card !== "object") return ["card is not an object"];
  if (card.schema !== "2.0") problems.push(`schema must be "2.0" (got ${JSON.stringify(card.schema)})`);
  if (!card.header?.title?.content) problems.push("header.title.content is missing");
  const elements = card.body?.elements;
  if (!Array.isArray(elements)) {
    problems.push("body.elements must be an array");
    return problems;
  }
  const seen = new Set();
  const visit = (el, where) => {
    if (!el || typeof el !== "object") return problems.push(`${where}: element is not an object`);
    if (typeof el.tag !== "string") problems.push(`${where}: element has no tag`);
    if (el.element_id !== undefined) {
      if (seen.has(el.element_id)) problems.push(`${where}: duplicate element_id ${el.element_id}`);
      seen.add(el.element_id);
    }
    for (const [i, child] of (Array.isArray(el.elements) ? el.elements : []).entries()) visit(child, `${where}.elements[${i}]`);
  };
  elements.forEach((el, i) => visit(el, `body.elements[${i}]`));
  return problems;
}

export async function startFakeLark({ port = Number(process.env.FAKE_LARK_PORT ?? 18080), host = "127.0.0.1" } = {}) {
  if (!LOOPBACK.has(host)) throw new Error(`fake-lark only binds loopback addresses, not ${host}`);

  const state = {
    startedAt: new Date().toISOString(),
    seq: 0,
    tokens: new Set(),
    sent: [],
    patched: [],
    byUuid: new Map(),
    violations: [],
    unsupported: [],
    calls: { token: 0, botInfo: 0, send: 0, sendDeduped: 0, patch: 0 },
  };
  const nextSeq = () => ++state.seq;

  const authorised = (req) => {
    const m = /^Bearer (t-fake-[0-9a-f]+)$/.exec(req.headers.authorization ?? "");
    return Boolean(m && state.tokens.has(m[1]));
  };
  const invalidToken = (res) =>
    envelope(res, 401, { code: 99991663, msg: "Invalid access token for authorization. Please make a request with token attached." });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}`);
      const route = `${req.method} ${url.pathname}`;

      // ── test controls ──────────────────────────────────────────────────
      if (route === "GET /__health") return envelope(res, 200, { ok: true, startedAt: state.startedAt });
      if (route === "GET /__sent") return envelope(res, 200, { data: state.sent });
      if (route === "GET /__patched") return envelope(res, 200, { data: state.patched });
      if (route === "GET /__calls") return envelope(res, 200, { data: state.calls });
      if (route === "GET /__violations") return envelope(res, 200, { data: state.violations });
      if (route === "GET /__unsupported") return envelope(res, 200, { data: state.unsupported });
      if (route === "POST /__reset") {
        state.sent.length = 0;
        state.patched.length = 0;
        state.violations.length = 0;
        state.unsupported.length = 0;
        state.byUuid.clear();
        for (const k of Object.keys(state.calls)) state.calls[k] = 0;
        return envelope(res, 200, { ok: true });
      }

      // ── tenant access token (self-built app) ───────────────────────────
      if (route === "POST /open-apis/auth/v3/tenant_access_token/internal") {
        const body = await readJson(req);
        state.calls.token += 1;
        if (typeof body.app_id !== "string" || !body.app_id || typeof body.app_secret !== "string" || !body.app_secret) {
          return envelope(res, 400, { code: 10003, msg: "invalid param" });
        }
        const token = `t-fake-${randomBytes(12).toString("hex")}`;
        state.tokens.add(token);
        return envelope(res, 200, { code: 0, msg: "ok", tenant_access_token: token, expire: 7200 });
      }

      // ── bot info ───────────────────────────────────────────────────────
      if (route === "GET /open-apis/bot/v3/info") {
        if (!authorised(req)) return invalidToken(res);
        state.calls.botInfo += 1;
        return envelope(res, 200, {
          code: 0,
          msg: "ok",
          bot: { activate_status: 2, app_name: "Fake NoPM Bot", avatar_url: "", ip_white_list: [], open_id: "ou_fake_bot" },
        });
      }

      // ── send a message ─────────────────────────────────────────────────
      if (route === "POST /open-apis/im/v1/messages") {
        if (!authorised(req)) return invalidToken(res);
        const body = await readJson(req);
        const idType = url.searchParams.get("receive_id_type");
        if (!["open_id", "chat_id", "user_id", "union_id", "email"].includes(idType ?? "")) {
          return envelope(res, 400, { code: 99992402, msg: "field validation failed: receive_id_type" });
        }
        if (typeof body.receive_id !== "string" || !body.receive_id) return envelope(res, 400, { code: 230001, msg: "receive_id is required" });
        if (body.msg_type !== "interactive") return envelope(res, 400, { code: 230001, msg: "this fake only accepts msg_type=interactive" });
        if (typeof body.content !== "string") return envelope(res, 400, { code: 230001, msg: "content must be a JSON string" });
        if (Buffer.byteLength(body.content, "utf8") > MAX_CARD_BYTES) {
          return envelope(res, 400, { code: 230025, msg: "The length of the message content reaches its limit." });
        }
        let card;
        try {
          card = JSON.parse(body.content);
        } catch {
          return envelope(res, 400, { code: 230001, msg: "content is not valid JSON" });
        }
        if (typeof body.uuid === "string" && state.byUuid.has(body.uuid)) {
          state.calls.sendDeduped += 1;
          return envelope(res, 200, { code: 0, msg: "success", data: { message_id: state.byUuid.get(body.uuid), msg_type: "interactive" } });
        }
        state.calls.send += 1;
        for (const problem of cardViolations(card)) state.violations.push({ receive_id: body.receive_id, problem });
        const messageId = `om_fake_${randomBytes(12).toString("hex")}`;
        const record = { seq: nextSeq(), message_id: messageId, receive_id_type: idType, receive_id: body.receive_id, uuid: body.uuid ?? null, card };
        state.sent.push(record);
        if (typeof body.uuid === "string") state.byUuid.set(body.uuid, messageId);
        return envelope(res, 200, {
          code: 0,
          msg: "success",
          data: { message_id: messageId, msg_type: "interactive", chat_id: "oc_fake_dm", create_time: String(Date.now()), sender: { id: "cli_fake", id_type: "app_id", sender_type: "app" } },
        });
      }

      // ── patch (replace) a card in place ────────────────────────────────
      const patchMatch = /^\/open-apis\/im\/v1\/messages\/([A-Za-z0-9_]+)$/.exec(url.pathname);
      if (patchMatch && (req.method === "PATCH" || req.method === "PUT")) {
        if (!authorised(req)) return invalidToken(res);
        const body = await readJson(req);
        state.calls.patch += 1;
        const messageId = patchMatch[1];
        const original = state.sent.find((m) => m.message_id === messageId);
        if (!original) return envelope(res, 400, { code: 230002, msg: "The message to update was not found (fake)." });
        if (typeof body.content !== "string") return envelope(res, 400, { code: 230001, msg: "content must be a JSON string" });
        let card;
        try {
          card = JSON.parse(body.content);
        } catch {
          return envelope(res, 400, { code: 230001, msg: "content is not valid JSON" });
        }
        if (original.card?.config?.update_multi !== true) {
          return envelope(res, 400, { code: 230001, msg: "only a card sent with config.update_multi=true can be updated (fake)." });
        }
        for (const problem of cardViolations(card)) state.violations.push({ message_id: messageId, problem });
        state.patched.push({ seq: nextSeq(), message_id: messageId, receive_id: original.receive_id, card });
        return envelope(res, 200, { code: 0, msg: "success", data: {} });
      }

      state.unsupported.push({ method: req.method, path: url.pathname });
      return envelope(res, 404, { code: 99991672, msg: `fake-lark does not implement ${req.method} ${url.pathname}` });
    } catch (e) {
      return envelope(res, 400, { code: 99992402, msg: `fake-lark: ${e.message}` });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const baseUrl = `http://${host}:${address.port}`;
  return {
    baseUrl,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ── standalone ───────────────────────────────────────────────────────────
const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const host = process.env.FAKE_LARK_HOST ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) {
    console.error(`fake-lark refuses to bind ${host}: loopback only.`);
    process.exit(2);
  }
  try {
    const fake = await startFakeLark({ host });
    console.log(`[fake-lark] listening on ${fake.baseUrl}`);
    console.log(`[fake-lark] start the app with NOPM_LARK_API_BASE_OVERRIDE=${fake.baseUrl}`);
    console.log("[fake-lark] state: GET /__sent  /__patched  /__calls  /__violations  /__unsupported  (POST /__reset)");
  } catch (e) {
    console.error(`[fake-lark] could not start: ${e.message}`);
    process.exit(3);
  }
}

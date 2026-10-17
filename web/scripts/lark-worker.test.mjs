// Offline tests for the pure parts of lark-worker.mjs - config validation, the
// relay client, the Lark callbacks, the single-instance lock. No socket is
// opened and no network is touched (fetch is injected).
//
//   node --test scripts/lark-worker.test.mjs
//
// The signing contract and the SDK-event -> envelope rebuild are additionally
// asserted against the server side and the real SDK in
// src/lib/integrations/lark/relay.test.ts (part of `npm run test`).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.NOPM_LARK_WORKER_IMPORT_ONLY = "1";
const w = await import("./lark-worker.mjs");

const APP_SECRET = "SENTINEL-app-secret-do-not-log";
const RELAY_SECRET = "SENTINEL-relay-secret-do-not-log-0123456789";
const CONNECTOR_ID = "0b6f3a52-7c1e-4d2a-9a47-5f1c2b3d4e5f";

const goodEnv = () => ({
  LARK_APP_ID: "cli_a1b2c3d4e5f6a7b8",
  LARK_APP_SECRET: APP_SECRET,
  LARK_REGION: "lark",
  NOPM_APP_URL: "https://nopm.example.com/",
  NOPM_LARK_CONNECTOR_ID: CONNECTOR_ID,
  NOPM_LARK_RELAY_SECRET: RELAY_SECRET,
});

const cfgOf = (over = {}) => {
  const r = w.loadConfig({ ...goodEnv(), ...over });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.config;
};

/** A logger that records every line so tests can assert nothing sensitive was written. */
const recordingLog = () => {
  const lines = [];
  const rec = (level) => (message, fields) => lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
  return { log: { info: rec("info"), warn: rec("warn"), error: rec("error") }, lines };
};

const reply = (status, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* ------------------------------------------------------------------ signing */

test("signing: independent vector (Python hmac/hashlib)", () => {
  const raw = "nopm-relay-test-secret-0123456789abcdef";
  const hash = w.hashRelaySecret(raw);
  assert.equal(hash, "df7827aa1c2c2afcbae0dbce738daf0c250e816844d119c02f3a03286152c029");
  assert.equal(
    w.signRelayBody(hash, "1760000000", '{"type":"ping"}'),
    "v1=4623421c8f8e467875a36dcac519aa14f0add20031dbf2547021b1f460f95e20",
  );
  const h = w.buildRelayHeaders(raw, '{"type":"ping"}', 1_760_000_000_999);
  assert.equal(h["x-nopm-relay-timestamp"], "1760000000");
  assert.equal(h["x-nopm-relay-signature"], "v1=4623421c8f8e467875a36dcac519aa14f0add20031dbf2547021b1f460f95e20");
});

/* ------------------------------------------------------------------- config */

test("config: a complete environment parses and normalises the URL", () => {
  const c = cfgOf();
  assert.equal(c.appUrl, "https://nopm.example.com");
  assert.equal(c.relayUrl, `https://nopm.example.com/api/integrations/lark/${CONNECTOR_ID}/relay`);
  assert.equal(c.region, "lark");
  assert.equal(c.timeoutMs, 2500);
  assert.equal(c.logLevel, "warn");
  assert.equal(c.allowMulti, false);
});

test("config: a path prefix on NOPM_APP_URL is kept, trailing slashes are not", () => {
  const c = cfgOf({ NOPM_APP_URL: "http://localhost:3000/nopm///" });
  assert.equal(c.relayUrl, `http://localhost:3000/nopm/api/integrations/lark/${CONNECTOR_ID}/relay`);
});

test("config: every problem is reported at once, and no value is ever echoed", () => {
  const r = w.loadConfig({ LARK_APP_SECRET: APP_SECRET, NOPM_LARK_RELAY_SECRET: "tiny-SENTINEL-1", LARK_APP_ID: "nope", LARK_REGION: "mars" });
  assert.equal(r.ok, false);
  const text = r.errors.join("\n");
  for (const name of ["LARK_APP_ID", "LARK_REGION", "NOPM_APP_URL", "NOPM_LARK_CONNECTOR_ID", "NOPM_LARK_RELAY_SECRET"]) {
    assert.ok(text.includes(name), `mentions ${name}`);
  }
  assert.ok(!text.includes(APP_SECRET));
  assert.ok(!text.includes("tiny-SENTINEL-1"));
  assert.ok(!text.includes("nope"));
  assert.ok(!text.includes("mars"));
});

test("config: LARK_REGION is required and case-insensitive", () => {
  const without = goodEnv();
  delete without.LARK_REGION;
  assert.equal(w.loadConfig(without).ok, false);
  assert.equal(cfgOf({ LARK_REGION: "Feishu" }).region, "feishu");
});

test("config: the SDK silently refuses a malformed app id, so we do not", () => {
  assert.equal(w.loadConfig({ ...goodEnv(), LARK_APP_ID: "cli_short" }).ok, false);
  assert.equal(w.loadConfig({ ...goodEnv(), LARK_APP_ID: "app_a1b2c3d4e5f6a7b8" }).ok, false);
});

test("config: plain http to a public-looking host warns; private hosts and https do not", () => {
  const warns = (url) => w.loadConfig({ ...goodEnv(), NOPM_APP_URL: url }).warnings.length;
  assert.equal(warns("http://nopm.example.com"), 1);
  assert.equal(warns("http://8.8.8.8:3000"), 1);
  assert.equal(warns("http://172.32.0.1"), 1, "172.32 is outside 172.16/12");
  for (const ok of [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
    "http://web:3000", // compose service name
    "http://nopm.internal",
    "http://host.docker.internal:3000",
    "http://10.1.2.3",
    "http://172.20.0.5",
    "http://192.168.1.10:3000",
    "https://nopm.example.com",
  ]) {
    assert.equal(warns(ok), 0, ok);
  }
});

test("config: non-http URLs and non-UUID connector ids are rejected", () => {
  assert.equal(w.loadConfig({ ...goodEnv(), NOPM_APP_URL: "ftp://x" }).ok, false);
  assert.equal(w.loadConfig({ ...goodEnv(), NOPM_APP_URL: "not a url" }).ok, false);
  assert.equal(w.loadConfig({ ...goodEnv(), NOPM_LARK_CONNECTOR_ID: "1234" }).ok, false);
});

test("config: debug logging is refused (SDK debug output contains event bodies)", () => {
  assert.equal(w.loadConfig({ ...goodEnv(), LARK_LOG_LEVEL: "debug" }).ok, false);
  assert.equal(w.loadConfig({ ...goodEnv(), LARK_LOG_LEVEL: "trace" }).ok, false);
  assert.equal(cfgOf({ LARK_LOG_LEVEL: "INFO" }).logLevel, "info");
});

test("config: relay timeout must leave room inside Lark's 3 s budget", () => {
  assert.equal(cfgOf({ NOPM_LARK_RELAY_TIMEOUT_MS: "1500" }).timeoutMs, 1500);
  for (const bad of ["100", "2801", "3000", "abc", "1.5"]) {
    assert.equal(w.loadConfig({ ...goodEnv(), NOPM_LARK_RELAY_TIMEOUT_MS: bad }).ok, false, bad);
  }
});

/* ------------------------------------------------------------------- relay */

test("relay: sends one signed POST with redirects disabled and returns the JSON", async () => {
  const cfg = cfgOf();
  let call;
  const fetch = async (url, init) => {
    call = { url, init };
    return reply(200, { toast: { type: "success", content: "done" } });
  };
  const out = await w.relay(cfg, "card", { header: { event_id: "e1" }, event: {} }, { fetch, now: () => 1_760_000_000_000 });
  assert.deepEqual(out, { status: 200, json: { toast: { type: "success", content: "done" } } });
  assert.equal(call.url, cfg.relayUrl);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.headers["content-type"], "application/json");
  assert.equal(call.init.headers["x-nopm-relay-timestamp"], "1760000000");
  assert.match(call.init.headers["x-nopm-relay-signature"], /^v1=[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(call.init.body), { type: "card", payload: { header: { event_id: "e1" }, event: {} } });
  assert.ok(call.init.signal instanceof AbortSignal);
});

test("relay: ping has no payload; non-object and empty 2xx bodies become {}", async () => {
  const cfg = cfgOf();
  let body;
  const ok = (resp) => async (_u, init) => { body = init.body; return resp(); };
  assert.deepEqual((await w.relay(cfg, "ping", undefined, { fetch: ok(() => reply(200, [1, 2])) })).json, {});
  assert.equal(body, '{"type":"ping"}');
  assert.deepEqual((await w.relay(cfg, "ping", undefined, { fetch: ok(() => new Response("not json", { status: 200 })) })).json, {});
  assert.deepEqual((await w.relay(cfg, "ping", undefined, { fetch: ok(() => reply(204)) })).json, {});
});

test("relay: failures are classified and carry fixed, operator-facing text", async () => {
  const cfg = cfgOf();
  const run = (resp) => w.relay(cfg, "event", {}, { fetch: async () => resp }).then(() => assert.fail("should throw"), (e) => e);

  const e401 = await run(reply(401, { error: "Invalid relay signature", code: "invalid_relay_signature" }));
  assert.equal(e401.name, "RelayError");
  assert.equal(e401.status, 401);
  assert.equal(e401.retryable, false);
  assert.match(e401.message, /clock/);

  assert.match((await run(reply(401, { code: "no_relay_secret" }))).message, /webhook mode/);
  assert.match((await run(reply(401, { code: "stale_relay_timestamp" }))).message, /clock/);

  const e403 = await run(reply(403, { error: "x", code: "wrong_mode" }));
  assert.equal(e403.code, "wrong_mode");
  assert.match(e403.message, /long-connection mode/);

  assert.match((await run(reply(403, { code: "connector_inactive" }))).message, /paused or revoked/);
  assert.match((await run(reply(404, { code: "connector_not_found" }))).message, /NOPM_LARK_CONNECTOR_ID/);

  for (const status of [429, 500, 502, 503]) {
    assert.equal((await run(reply(status, { error: "boom" }))).retryable, true, String(status));
  }
  for (const status of [400, 413, 422]) {
    assert.equal((await run(reply(status, { error: "bad" }))).retryable, false, String(status));
  }
});

test("relay: an arbitrary response body or code never reaches the error text", async () => {
  const cfg = cfgOf();
  const err = await w
    .relay(cfg, "event", {}, { fetch: async () => reply(422, { error: "leaked chat text hello", code: "Not A Safe Code!" }) })
    .then(() => assert.fail("should throw"), (e) => e);
  assert.ok(!err.message.includes("leaked"));
  assert.equal(err.code, undefined); // code fails the /^[a-z_]{1,40}$/ allowlist
});

test("relay: network failure and timeout are retryable and do not leak the URL", async () => {
  const cfg = cfgOf();
  const net = await w
    .relay(cfg, "event", {}, { fetch: async () => { throw new TypeError(`fetch failed ${cfg.relayUrl}`); } })
    .then(() => assert.fail("should throw"), (e) => e);
  assert.equal(net.status, 0);
  assert.equal(net.retryable, true);
  assert.equal(net.code, "network");
  assert.ok(!net.message.includes(CONNECTOR_ID));

  const timeout = await w
    .relay(cfg, "event", {}, { fetch: async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); } })
    .then(() => assert.fail("should throw"), (e) => e);
  assert.equal(timeout.code, "timeout");
});

/* ---------------------------------------------------------------- callbacks */

const flatMessage = (id = "ev_1", messageId = undefined) => ({
  schema: "2.0",
  event_id: id,
  event_type: "im.message.receive_v1",
  token: "verification-token-value",
  tenant_key: "tk_1",
  app_id: "cli_a1b2c3d4e5f6a7b8",
  sender: { sender_id: { open_id: "ou_abc" } },
  message: { ...(messageId ? { message_id: messageId } : {}), content: '{"text":"SECRET CHAT TEXT"}' },
});

const flatCard = (id = "ev_c1") => ({
  schema: "2.0",
  event_id: id,
  event_type: "card.action.trigger",
  token: "c-card-update-token",
  tenant_key: "tk_1",
  app_id: "cli_a1b2c3d4e5f6a7b8",
  operator: { open_id: "ou_abc" },
  action: { value: { t: "ACTION-TOKEN-SECRET", a: "approve" }, tag: "button" },
});

test("callbacks: a message event is relayed once; a Lark re-push of the same event id is skipped", async () => {
  const { log, lines } = recordingLog();
  const calls = [];
  const fetch = async (_u, init) => { calls.push(JSON.parse(init.body)); return reply(200, {}); };
  const seen = w.createSeenCache();
  const h = w.createHandlers({ cfg: cfgOf(), log, seen, deps: { fetch } });

  assert.equal(await h["im.message.receive_v1"](flatMessage()), undefined);
  assert.equal(await h["im.message.receive_v1"](flatMessage()), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "event");
  assert.equal(calls[0].payload.header.event_id, "ev_1");
  assert.ok(!JSON.stringify(calls[0]).includes("verification-token-value"), "app verification token is not forwarded");

  const logged = lines.join("\n");
  for (const secret of ["SECRET CHAT TEXT", APP_SECRET, RELAY_SECRET, "verification-token-value", "ou_abc"]) {
    assert.ok(!logged.includes(secret), `log must not contain ${secret}`);
  }
});

test("callbacks: a Lark re-push of the same MESSAGE under a new event id is skipped (dedupe is on message_id)", async () => {
  const { log } = recordingLog();
  const calls = [];
  const fetch = async (_u, init) => { calls.push(JSON.parse(init.body)); return reply(200, {}); };
  const seen = w.createSeenCache();
  const h = w.createHandlers({ cfg: cfgOf(), log, seen, deps: { fetch } });

  await h["im.message.receive_v1"](flatMessage("ev_first", "om_same"));
  await h["im.message.receive_v1"](flatMessage("ev_repush", "om_same"));
  assert.equal(calls.length, 1);
  assert.equal(seen.has("om_same"), true);

  await h["im.message.receive_v1"](flatMessage("ev_other", "om_other")); // a different message is relayed
  assert.equal(calls.length, 2);
});

test("callbacks: a retryable event failure throws (Lark re-pushes) and is not remembered", async () => {
  const { log } = recordingLog();
  let n = 0;
  const fetch = async () => (++n === 1 ? reply(503, {}) : reply(200, {}));
  const seen = w.createSeenCache();
  const h = w.createHandlers({ cfg: cfgOf(), log, seen, deps: { fetch } });

  await assert.rejects(() => h["im.message.receive_v1"](flatMessage("ev_retry")), { name: "RelayError", retryable: true });
  assert.equal(seen.has("ev_retry"), false);
  assert.equal(await h["im.message.receive_v1"](flatMessage("ev_retry")), undefined);
  assert.equal(seen.has("ev_retry"), true);
});

test("callbacks: a non-retryable event failure is swallowed (a re-push would fail identically)", async () => {
  const { log } = recordingLog();
  const h = w.createHandlers({ cfg: cfgOf(), log, seen: w.createSeenCache(), deps: { fetch: async () => reply(403, { code: "wrong_mode" }) } });
  assert.equal(await h["im.message.receive_v1"](flatMessage()), undefined);
});

test("callbacks: a card click returns the relay's JSON verbatim as the Lark response", async () => {
  const { log, lines } = recordingLog();
  const response = { toast: { type: "success", content: "Approved" }, card: { type: "raw", data: { schema: "2.0" } } };
  const calls = [];
  const h = w.createHandlers({
    cfg: cfgOf(),
    log,
    seen: w.createSeenCache(),
    deps: { fetch: async (_u, init) => { calls.push(JSON.parse(init.body)); return reply(200, response); } },
  });
  assert.deepEqual(await h["card.action.trigger"](flatCard()), response);
  assert.equal(calls[0].type, "card");
  assert.equal(calls[0].payload.event.token, "c-card-update-token");
  assert.equal(calls[0].payload.event.action.value.t, "ACTION-TOKEN-SECRET");
  assert.ok(!lines.join("\n").includes("ACTION-TOKEN-SECRET"), "the action token is never logged");
});

test("callbacks: an empty relay answer sends nothing back; card clicks are never deduped locally", async () => {
  const { log } = recordingLog();
  let n = 0;
  const h = w.createHandlers({ cfg: cfgOf(), log, seen: w.createSeenCache(), deps: { fetch: async () => { n++; return reply(200, {}); } } });
  assert.equal(await h["card.action.trigger"](flatCard("same")), undefined);
  assert.equal(await h["card.action.trigger"](flatCard("same")), undefined);
  assert.equal(n, 2, "NoPM owns card idempotency (single-use token + event id)");
});

test("callbacks: a card click that cannot reach NoPM answers with an error toast, not a Lark 200340", async () => {
  const { log } = recordingLog();
  const down = w.createHandlers({ cfg: cfgOf(), log, seen: w.createSeenCache(), deps: { fetch: async () => { throw new TypeError("fetch failed"); } } });
  const slow = await down["card.action.trigger"](flatCard());
  assert.equal(slow.toast.type, "error");
  assert.match(slow.toast.content, /did not answer in time/);

  const rejected = w.createHandlers({ cfg: cfgOf(), log, seen: w.createSeenCache(), deps: { fetch: async () => reply(500, {}) } });
  const other = await rejected["card.action.trigger"](flatCard());
  assert.equal(other.toast.type, "error");
  assert.match(other.toast.content, /Open the request in NoPM/);
});

test("callbacks: in-flight work is tracked so shutdown can wait for it", async () => {
  const { log } = recordingLog();
  const tracked = [];
  const h = w.createHandlers({
    cfg: cfgOf(),
    log,
    seen: w.createSeenCache(),
    track: (p) => { tracked.push(p); return p; },
    deps: { fetch: async () => reply(200, {}) },
  });
  await h["card.action.trigger"](flatCard());
  await h["im.message.receive_v1"](flatMessage());
  assert.equal(tracked.length, 2);
});

/* --------------------------------------------------------------- seen cache */

test("seen cache: entries expire and the map is bounded", () => {
  let t = 1000;
  const c = w.createSeenCache({ ttlMs: 100, max: 3, now: () => t });
  c.add("a");
  assert.equal(c.has("a"), true);
  t += 101;
  assert.equal(c.has("a"), false);

  for (const id of ["1", "2", "3", "4", "5"]) c.add(id);
  assert.ok(c.size <= 3);
  assert.equal(c.has("5"), true);
  assert.equal(c.has(undefined), false);
});

/* ------------------------------------------------------------ single instance */

test("lock: a second live worker for the same connector is refused; a stale lock is reclaimed", () => {
  const dir = mkdtempSync(join(tmpdir(), "nopm-lock-test-"));
  try {
    const first = w.acquireLock(CONNECTOR_ID, { dir, pid: 111, isAlive: () => true });
    assert.equal(first.ok, true);
    assert.equal(readFileSync(first.file, "utf8"), "111");

    const second = w.acquireLock(CONNECTOR_ID, { dir, pid: 222, isAlive: () => true });
    assert.equal(second.ok, false);
    assert.equal(second.pid, 111);

    const reclaimed = w.acquireLock(CONNECTOR_ID, { dir, pid: 333, isAlive: () => false });
    assert.equal(reclaimed.ok, true);
    assert.equal(readFileSync(reclaimed.file, "utf8"), "333");

    reclaimed.release();
    assert.equal(existsSync(reclaimed.file), false);

    // A different connector id never collides.
    const other = w.acquireLock("11111111-1111-4111-8111-111111111111", { dir, pid: 444, isAlive: () => true });
    assert.equal(other.ok, true);
    other.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock: an unreadable lock file is treated as stale; an unusable directory does not block startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "nopm-lock-test-"));
  try {
    const first = w.acquireLock(CONNECTOR_ID, { dir, pid: 1, isAlive: () => true });
    writeFileSync(first.file, "garbage");
    const next = w.acquireLock(CONNECTOR_ID, { dir, pid: 2, isAlive: () => true });
    assert.equal(next.ok, true);
    next.release();

    const noDir = w.acquireLock(CONNECTOR_ID, { dir: join(dir, "does", "not", "exist"), pid: 3 });
    assert.equal(noDir.ok, true);
    assert.equal(noDir.unlocked, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- preflight */

test("preflight: ok on first success", async () => {
  const { log } = recordingLog();
  const r = await w.preflight(cfgOf(), log, { fetch: async () => reply(200, { data: { ok: true } }), sleep: async () => {} });
  assert.deepEqual(r, { ok: true });
});

test("preflight: configuration errors (401/403/404) fail fast, without retrying", async () => {
  const { log } = recordingLog();
  for (const status of [401, 403, 404]) {
    let n = 0;
    const r = await w.preflight(cfgOf(), log, { fetch: async () => { n++; return reply(status, {}); }, sleep: async () => {} });
    assert.equal(r.ok, false);
    assert.equal(r.fatal, true);
    assert.equal(n, 1, `status ${status}`);
  }
});

test("preflight: NoPM still starting up is retried, then succeeds", async () => {
  const { log, lines } = recordingLog();
  let n = 0;
  const sleeps = [];
  const r = await w.preflight(cfgOf(), log, {
    fetch: async () => { n++; if (n < 3) throw new TypeError("fetch failed"); return reply(200, {}); },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.deepEqual(r, { ok: true });
  assert.equal(n, 3);
  assert.deepEqual(sleeps, [2000, 4000]);
  assert.equal(lines.filter((l) => l.startsWith("warn relay check failed")).length, 2);
});

test("preflight: gives up (non-fatal, so a supervisor restarts it) when NoPM never answers", async () => {
  const { log } = recordingLog();
  const r = await w.preflight(cfgOf(), log, { fetch: async () => reply(503, {}), sleep: async () => {}, delays: [0, 1, 1] });
  assert.equal(r.ok, false);
  assert.equal(r.fatal, false);
});

/* -------------------------------------------------------------------- toEnvelope */

test("toEnvelope: hoists header fields back, drops symbol keys and the verification token", () => {
  const flat = { ...flatMessage(), [Symbol("event-type")]: "im.message.receive_v1" };
  const env = w.toEnvelope(flat);
  assert.deepEqual(Object.keys(env.header).sort(), ["app_id", "event_id", "event_type", "tenant_key"]);
  assert.deepEqual(Object.keys(env.event).sort(), ["message", "sender"]);
  assert.equal(Object.getOwnPropertySymbols(env.event).length, 0);
  assert.equal(env.schema, "2.0");
});

test("toEnvelope: tolerates a missing input", () => {
  assert.deepEqual(w.toEnvelope(undefined), { schema: "2.0", header: {}, event: {} });
});

/* ----------------------------------------------------------- frame probe */

const frameOf = (type) => ({ headers: [{ key: "type", value: type }, { key: "message_id", value: "m1" }], payload: new Uint8Array([1]) });

test("frame probe: a data frame whose type is not 'event' is logged (type only) and still handed to the SDK untouched", async () => {
  const { log, lines } = recordingLog();
  const handled = [];
  const ws = { handleEventData: async (frame) => { handled.push(frame); return "sdk-result"; } };
  assert.equal(w.installFrameProbe(ws, log), true);

  const card = frameOf("card");
  assert.equal(await ws.handleEventData(card), "sdk-result");
  assert.equal(handled[0], card);
  assert.equal(lines.filter((l) => l.startsWith("warn ws frame with a non-event type")).length, 1);
  assert.ok(lines.join("\n").includes('"type":"card"'));
  assert.ok(!lines.join("\n").includes("m1"), "nothing but the frame type is logged");

  await ws.handleEventData(frameOf("event"));
  assert.equal(lines.filter((l) => l.startsWith("warn ws frame")).length, 1, "a normal event frame logs nothing");
  assert.equal(handled.length, 2);
});

test("frame probe: a frame with no readable type headers is passed through without logging", async () => {
  const { log, lines } = recordingLog();
  const ws = { handleEventData: async () => "ok" };
  w.installFrameProbe(ws, log);
  assert.equal(await ws.handleEventData({}), "ok");
  assert.equal(await ws.handleEventData(undefined), "ok");
  assert.equal(lines.filter((l) => l.startsWith("warn")).length, 0);
});

test("frame probe: does nothing when the SDK has no such method (a bump that renamed it)", () => {
  const { log } = recordingLog();
  assert.equal(w.installFrameProbe({}, log), false);
  assert.equal(w.installFrameProbe(undefined, log), false);
});

test("frame probe: the pinned SDK still has the private handleEventData the probe wraps", async () => {
  const Lark = await import("@larksuiteoapi/node-sdk");
  const sdk = Lark.WSClient ? Lark : Lark.default;
  assert.equal(typeof sdk.WSClient.prototype.handleEventData, "function");
});

/* ----------------------------------------------------------- lark failures */

test("lark failures: rejected credentials and a duplicate connection are config errors (exit 2), the rest are restartable", () => {
  assert.equal(w.classifyLarkFailure("pullConnectConfig failed: code=514, msg=auth failed").exitCode, 2);
  assert.equal(w.classifyLarkFailure("pullConnectConfig failed: code=403, msg=forbidden").exitCode, 2);
  assert.match(w.classifyLarkFailure("pullConnectConfig failed: code=514, msg=x").hint, /LARK_REGION/);
  const dup = w.classifyLarkFailure("pullConnectConfig failed: code=1000040350, msg=exceed conn limit");
  assert.equal(dup.exitCode, 2);
  assert.match(dup.hint, /exactly one/);
  assert.deepEqual(w.classifyLarkFailure("WebSocket reconnect exhausted after 5 attempts"), { exitCode: 1, hint: null });
  assert.deepEqual(w.classifyLarkFailure(undefined), { exitCode: 1, hint: null });
});

/* ------------------------------------------------------------------- logger */

test("logger: one line per call, ISO timestamp, undefined fields omitted", () => {
  const out = [];
  const sink = { log: (l) => out.push(l), warn: (l) => out.push(l), error: (l) => out.push(l) };
  const log = w.createLogger(sink);
  log.info("hello", { a: 1, b: undefined, c: "x" });
  log.error("bad");
  assert.match(out[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[nopm-lark-worker\] info hello a=1 c=x$/);
  assert.match(out[1], /error bad$/);
});

/* ---------------------------------------------- against the real SDK dispatcher */

test("sdk: the handlers register on the real EventDispatcher and answer a raw card frame end to end", async () => {
  const Lark = await import("@larksuiteoapi/node-sdk");
  const sdk = Lark.EventDispatcher ? Lark : Lark.default;
  const { log } = recordingLog();
  const sent = [];
  const reply = { toast: { type: "success", content: "Approved" } };
  const handlers = w.createHandlers({
    cfg: cfgOf(),
    log,
    seen: w.createSeenCache(),
    deps: { fetch: async (_u, init) => { sent.push(JSON.parse(init.body)); return new Response(JSON.stringify(reply), { status: 200 }); } },
  });
  const dispatcher = new sdk.EventDispatcher({ loggerLevel: sdk.LoggerLevel.error }).register(handlers);

  // Exactly what WSClient.handleEventData hands to invoke(): the parsed frame payload.
  const rawCard = {
    schema: "2.0",
    header: { event_id: "ev_c9", token: "verification-token-value", create_time: "1760000000000", event_type: "card.action.trigger", tenant_key: "tk_1", app_id: "cli_a1b2c3d4e5f6a7b8" },
    event: { operator: { open_id: "ou_abc", tenant_key: "tk_1" }, token: "c-upd", action: { value: { t: "tok", a: "approve" }, tag: "button" } },
  };
  assert.deepEqual(await dispatcher.invoke(rawCard, { needCheck: false }), reply);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "card");
  assert.equal(sent[0].payload.header.event_type, "card.action.trigger");
  assert.equal(sent[0].payload.event.token, "c-upd");
  assert.ok(!JSON.stringify(sent[0]).includes("verification-token-value"));

  const rawMessage = {
    schema: "2.0",
    header: { event_id: "ev_m9", token: "verification-token-value", event_type: "im.message.receive_v1", tenant_key: "tk_1", app_id: "cli_a1b2c3d4e5f6a7b8" },
    event: { sender: { sender_id: { open_id: "ou_abc" }, sender_type: "user" }, message: { chat_type: "p2p", message_type: "text", content: '{"text":"help"}' } },
  };
  assert.equal(await dispatcher.invoke(rawMessage, { needCheck: false }), undefined);
  assert.equal(sent.at(-1).type, "event");
});

test("sdk: the pinned SDK still exposes what the worker relies on", async () => {
  const Lark = await import("@larksuiteoapi/node-sdk");
  const sdk = Lark.WSClient ? Lark : Lark.default;
  assert.equal(typeof sdk.WSClient, "function");
  assert.equal(typeof sdk.EventDispatcher, "function");
  assert.equal(typeof sdk.WSClient.prototype.start, "function");
  assert.equal(typeof sdk.WSClient.prototype.close, "function");
  assert.equal(typeof sdk.WSClient.prototype.getConnectionStatus, "function");
  assert.ok("Lark" in sdk.Domain && "Feishu" in sdk.Domain);
  for (const level of ["error", "warn", "info"]) assert.ok(level in sdk.LoggerLevel, level);
  // Constructing (not starting) opens no socket and touches no network.
  const ws = new sdk.WSClient({ appId: "cli_a1b2c3d4e5f6a7b8", appSecret: "x", domain: sdk.Domain.Feishu, loggerLevel: sdk.LoggerLevel.error, onReady() {}, onError() {} });
  assert.equal(ws.getConnectionStatus().state, "idle");
  ws.close();
});

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { DefaultCache } from "@larksuiteoapi/node-sdk";
import { MAX_CARD_BYTES, classifyLarkError, patchCard, sendCard, testBot, withRequestTimeout, type ClientOverrides } from "./client";
import { fixtureConnector, fixtureConfig, fixtureSecrets } from "./fixtures";

type Call = { url?: string; method?: string; data?: Record<string, unknown>; params?: Record<string, unknown>; headers?: Record<string, unknown> };

const TOKEN = "t-fixture-tenant-token-NEVER-LOG";

/** In-memory stand-in for the SDK's HTTP layer: no request ever leaves the process. */
function makeHttp(onRequest: (call: Call) => unknown | Promise<unknown> = () => ({ code: 0, msg: "ok", data: { message_id: "om_sent_1" } }), onPost?: (url: string, body: unknown) => unknown) {
  const calls: Call[] = [];
  const posts: { url: string; body: unknown }[] = [];
  const http = {
    request: async (call: Call) => {
      calls.push(call);
      return onRequest(call);
    },
    post: async (url: string, body: unknown) => {
      posts.push({ url, body });
      return onPost ? onPost(url, body) : { code: 0, tenant_access_token: TOKEN, expire: 7200 };
    },
    get: async () => ({}),
    delete: async () => ({}),
    head: async () => ({}),
    options: async () => ({}),
    put: async () => ({}),
    patch: async () => ({}),
  };
  return { http: http as unknown as ClientOverrides["httpInstance"], calls, posts };
}

function overrides(h: ReturnType<typeof makeHttp>, extra: Partial<ClientOverrides> = {}): ClientOverrides {
  return { httpInstance: h.http, cache: new DefaultCache(), ...extra };
}

/** What axios throws for a non-2xx response (note `config.headers.Authorization`). */
function axiosError(status: number, data: unknown, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data, headers },
    config: { headers: { Authorization: `Bearer ${TOKEN}` }, data: '{"secret":"body"}' },
  });
}

const card = { schema: "2.0", header: { title: { tag: "plain_text", content: "hello" } }, body: { elements: [] } };

afterEach(() => vi.restoreAllMocks());

describe("sendCard", () => {
  it("DMs an interactive card to an open_id on the Lark domain", async () => {
    const h = makeHttp();
    const res = await sendCard(fixtureConnector(), fixtureSecrets(), { receiveIdType: "open_id", receiveId: "ou_abc", body: card }, overrides(h));

    expect(res).toEqual({ ok: true, externalMessageId: "om_sent_1" });
    expect(h.posts[0].url).toBe("https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal");
    expect(h.posts[0].body).toEqual({ app_id: "cli_fixture_app", app_secret: fixtureSecrets().appSecret });
    const call = h.calls[0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://open.larksuite.com/open-apis/im/v1/messages");
    expect(call.params).toEqual({ receive_id_type: "open_id" });
    expect(call.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.data).toMatchObject({ receive_id: "ou_abc", msg_type: "interactive", content: JSON.stringify(card) });
  });

  it("targets a group by chat_id", async () => {
    const h = makeHttp();
    await sendCard(fixtureConnector(), fixtureSecrets(), { receiveIdType: "chat_id", receiveId: "oc_group", body: card }, overrides(h));
    expect(h.calls[0].params).toEqual({ receive_id_type: "chat_id" });
    expect(h.calls[0].data?.receive_id).toBe("oc_group");
  });

  it("uses the Feishu domain for a feishu connector", async () => {
    const h = makeHttp();
    await sendCard(
      fixtureConnector({ config: fixtureConfig({ region: "feishu" }) }),
      fixtureSecrets(),
      { receiveIdType: "open_id", receiveId: "ou_abc", body: card },
      overrides(h),
    );
    expect(h.posts[0].url).toBe("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal");
    expect(h.calls[0].url).toBe("https://open.feishu.cn/open-apis/im/v1/messages");
  });

  it("derives a stable <=50 char uuid per recipient+content so a retried delivery is deduplicated", async () => {
    const h = makeHttp();
    const send = (body: Record<string, unknown>, to = "ou_abc") =>
      sendCard(fixtureConnector(), fixtureSecrets(), { receiveIdType: "open_id", receiveId: to, body }, overrides(h));
    await send(card);
    await send(card);
    await send({ ...card, extra: 1 });
    await send(card, "ou_other");
    const uuids = h.calls.map((c) => String(c.data?.uuid));
    expect(uuids[0]).toBe(uuids[1]);
    expect(uuids[2]).not.toBe(uuids[0]);
    expect(uuids[3]).not.toBe(uuids[0]);
    for (const u of uuids) expect(u.length).toBeLessThanOrEqual(50);
  });

  it("refuses an oversized card without calling the platform", async () => {
    const h = makeHttp();
    const big = { ...card, pad: "x".repeat(MAX_CARD_BYTES) };
    const res = await sendCard(fixtureConnector(), fixtureSecrets(), { receiveIdType: "open_id", receiveId: "ou_abc", body: big }, overrides(h));
    expect(res).toEqual({ ok: false, retryable: false, error: "card exceeds the 30 KB platform limit" });
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    ["an empty object", {}],
    ["an HTML page from a proxy", "<html><body>Bad gateway</body></html>"],
    ["a null body", null],
    ["a code that is not a number", { code: "0", data: { message_id: "om_x" } }],
    ["success with no data", { code: 0 }],
    ["success with no message id", { code: 0, data: {} }],
    ["success with an empty message id", { code: 0, data: { message_id: "" } }],
    ["success with a message id that is not text", { code: 0, data: { message_id: 42 } }],
  ])("is never recorded as sent when the platform answers 200 with %s (retryable: nothing says it was delivered)", async (_label, body) => {
    const h = makeHttp(() => body);
    const res = await sendCard(fixtureConnector(), fixtureSecrets(), { receiveIdType: "open_id", receiveId: "ou_abc", body: card }, overrides(h));
    expect(res).toEqual({ ok: false, retryable: true, error: "unexpected response" });
  });
});

describe("failure handling", () => {
  const send = (h: ReturnType<typeof makeHttp>, extra: Partial<ClientOverrides> = {}) =>
    sendCard(fixtureConnector(), fixtureSecrets(), { receiveIdType: "open_id", receiveId: "ou_abc", body: card }, overrides(h, extra));

  it("HTTP 429 is retryable and carries the platform's reset hint", async () => {
    const h = makeHttp(() => {
      throw axiosError(429, { code: 99991400, msg: "request trigger frequency limit" }, { "x-ogw-ratelimit-reset": "12" });
    });
    const res = await send(h);
    expect(res).toMatchObject({ ok: false, retryable: true });
    expect((res as { error: string }).error).toContain("retry after 12s");
  });

  it("business frequency codes at HTTP 200 are retryable (230020, 11232)", async () => {
    for (const code of [230020, 11232, 99991400]) {
      const h = makeHttp(() => ({ code, msg: "frequency limit" }));
      expect(await send(h)).toMatchObject({ ok: false, retryable: true });
    }
  });

  it("permanent business errors are not retried (bot not in chat, outside availability scope, bad id)", async () => {
    for (const code of [230001, 230002, 230006, 230013, 230027, 230034, 230035, 230099]) {
      const h = makeHttp(() => ({ code, msg: `err ${code}` }));
      const res = await send(h);
      expect(res).toMatchObject({ ok: false, retryable: false });
      expect((res as { error: string }).error).toContain(String(code));
    }
  });

  it("5xx is retryable, other 4xx is not", async () => {
    expect(await send(makeHttp(() => { throw axiosError(503, "upstream"); }))).toMatchObject({ ok: false, retryable: true });
    expect(await send(makeHttp(() => { throw axiosError(400, { code: 230001, msg: "invalid" }); }))).toMatchObject({ ok: false, retryable: false });
    expect(await send(makeHttp(() => { throw axiosError(403, { code: 230027, msg: "no permission" }); }))).toMatchObject({ ok: false, retryable: false });
  });

  it("rejected app credentials are not retried", async () => {
    const h = makeHttp(undefined, () => ({ code: 10003, msg: "invalid param" }));
    const res = await send(h);
    expect(res).toMatchObject({ ok: false, retryable: false });
    expect((res as { error: string }).error).toContain("credentials rejected");
    expect(h.calls).toHaveLength(0);
  });

  it("network failures and timeouts are retryable", async () => {
    const reset = makeHttp(() => {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });
    expect(await send(reset)).toMatchObject({ ok: false, retryable: true });

    const hung = makeHttp(() => new Promise(() => undefined));
    expect(await send(hung, { timeoutMs: 25 })).toMatchObject({ ok: false, retryable: true });
  });

  it("never leaks the access token, app secret or request body into the error text", async () => {
    const h = makeHttp(() => {
      throw axiosError(400, { code: 230001, msg: "invalid" });
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await send(h);
    const text = JSON.stringify(res);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(fixtureSecrets().appSecret);
    expect(text).not.toContain("secret");
    // The SDK's default logger prints request bodies (which hold action tokens); ours is silent.
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("patchCard", () => {
  it("PATCHes the message with the new card content", async () => {
    const h = makeHttp(() => ({ code: 0, msg: "ok", data: {} }));
    const res = await patchCard(fixtureConnector(), fixtureSecrets(), "om_existing_9", card, overrides(h));
    expect(res).toEqual({ ok: true, externalMessageId: "om_existing_9" });
    expect(h.calls[0].method).toBe("PATCH");
    expect(h.calls[0].url).toBe("https://open.larksuite.com/open-apis/im/v1/messages/om_existing_9");
    expect(h.calls[0].data).toEqual({ content: JSON.stringify(card) });
  });

  it.each([
    ["an empty object", {}],
    ["an HTML page from a proxy", "<html><body>Bad gateway</body></html>"],
    ["a null body", null],
    ["a code that is not a number", { code: "0" }],
  ])("is never recorded as patched when the platform answers 200 with %s (retryable)", async (_label, body) => {
    const h = makeHttp(() => body);
    const res = await patchCard(fixtureConnector(), fixtureSecrets(), "om_existing_9", card, overrides(h));
    expect(res).toEqual({ ok: false, retryable: true, error: "unexpected response" });
  });

  it("needs no message id in the reply: a patch that answers code 0 succeeded", async () => {
    const h = makeHttp(() => ({ code: 0 }));
    expect(await patchCard(fixtureConnector(), fixtureSecrets(), "om_existing_9", card, overrides(h))).toEqual({
      ok: true,
      externalMessageId: "om_existing_9",
    });
  });

  it("treats the 14-day edit window (230031) as permanent and a recalled message (230011) too", async () => {
    for (const code of [230031, 230011, 230110]) {
      const h = makeHttp(() => ({ code, msg: "gone" }));
      expect(await patchCard(fixtureConnector(), fixtureSecrets(), "om_x", card, overrides(h))).toMatchObject({ ok: false, retryable: false });
    }
  });

  it("retries a rate-limited patch", async () => {
    const h = makeHttp(() => {
      throw axiosError(429, { code: 230020, msg: "freq" });
    });
    expect(await patchCard(fixtureConnector(), fixtureSecrets(), "om_x", card, overrides(h))).toMatchObject({ ok: false, retryable: true });
  });
});

describe("testBot", () => {
  it("returns the bot's app name", async () => {
    const h = makeHttp(() => ({ code: 0, msg: "ok", bot: { app_name: "NoPM Bot", open_id: "ou_bot" } }));
    expect(await testBot(fixtureConnector(), fixtureSecrets(), overrides(h))).toEqual({ ok: true, botName: "NoPM Bot" });
    expect(h.calls[0].method).toBe("GET");
    expect(h.calls[0].url).toBe("https://open.larksuite.com/open-apis/bot/v3/info");
  });

  it("reports a missing bot capability", async () => {
    const h = makeHttp(() => ({ code: 0, msg: "ok" }));
    expect(await testBot(fixtureConnector(), fixtureSecrets(), overrides(h))).toEqual({
      ok: false,
      error: "bot capability is not enabled for this app",
    });
  });

  it("reports rejected credentials and platform errors without secrets", async () => {
    const badCreds = makeHttp(undefined, () => ({ code: 10014, msg: "app secret invalid" }));
    const r1 = await testBot(fixtureConnector(), fixtureSecrets(), overrides(badCreds));
    expect(r1.ok).toBe(false);
    expect(JSON.stringify(r1)).not.toContain(fixtureSecrets().appSecret);

    const denied = makeHttp(() => ({ code: 99991672, msg: "no permission" }));
    expect(await testBot(fixtureConnector(), fixtureSecrets(), overrides(denied))).toMatchObject({ ok: false });
  });
});

describe("classifyLarkError", () => {
  it("is safe on garbage input", () => {
    expect(classifyLarkError(undefined)).toMatchObject({ ok: false, retryable: true });
    expect(classifyLarkError("boom")).toMatchObject({ ok: false });
    expect(classifyLarkError(null)).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Real SDK + real axios against a loopback server: proves the error shapes the
// classifier relies on (status, body code, x-ogw-ratelimit-reset) are the ones
// the SDK actually surfaces. Loopback only - nothing here reaches the platform.
// ---------------------------------------------------------------------------
describe("against a loopback server (real axios error shapes)", () => {
  type Reply = { status: number; headers?: Record<string, string>; body: unknown };
  let server: Server;
  let base = "";
  let messageReply: Reply = { status: 200, body: { code: 0, msg: "ok", data: { message_id: "om_loop_1" } } };
  const seen: { method?: string; url?: string; auth?: string; body?: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw });
        const reply: Reply = req.url?.includes("tenant_access_token")
          ? { status: 200, body: { code: 0, msg: "ok", tenant_access_token: "t-loop", expire: 7200 } }
          : messageReply;
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const send = () =>
    sendCard(
      fixtureConnector(),
      fixtureSecrets(),
      { receiveIdType: "open_id", receiveId: "ou_loop", body: card },
      { domain: base, cache: new DefaultCache() },
    );

  it("a 200 reply is a success with the message id", async () => {
    messageReply = { status: 200, body: { code: 0, msg: "ok", data: { message_id: "om_loop_1" } } };
    seen.length = 0;
    expect(await send()).toEqual({ ok: true, externalMessageId: "om_loop_1" });
    const post = seen.find((s) => s.url?.startsWith("/open-apis/im/v1/messages"));
    expect(post?.method).toBe("POST");
    expect(post?.url).toContain("receive_id_type=open_id");
    expect(post?.auth).toBe("Bearer t-loop");
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({ receive_id: "ou_loop", msg_type: "interactive" });
  });

  it("HTTP 429 with x-ogw-ratelimit-reset is retryable and reports the wait", async () => {
    messageReply = {
      status: 429,
      headers: { "x-ogw-ratelimit-reset": "17", "x-ogw-ratelimit-limit": "50" },
      body: { code: 99991400, msg: "request trigger frequency limit" },
    };
    const res = await send();
    expect(res).toMatchObject({ ok: false, retryable: true });
    expect((res as { error: string }).error).toContain("retry after 17s");
  });

  it("HTTP 400 with a business code is permanent (bot not in the chat)", async () => {
    messageReply = { status: 400, body: { code: 230002, msg: "Bot/User can NOT be out of the chat." } };
    const res = await send();
    expect(res).toMatchObject({ ok: false, retryable: false });
    expect((res as { error: string }).error).toContain("230002");
  });

  it("HTTP 500 is retryable", async () => {
    messageReply = { status: 500, body: { code: 1, msg: "internal" } };
    expect(await send()).toMatchObject({ ok: false, retryable: true });
  });

  it("HTTP 200 carrying a business error code is classified, not treated as success", async () => {
    messageReply = { status: 200, body: { code: 230013, msg: "Bot has NO availability to this user." } };
    expect(await send()).toMatchObject({ ok: false, retryable: false });
  });

  it("an unreachable platform is a retryable network error", async () => {
    const res = await sendCard(
      fixtureConnector(),
      fixtureSecrets(),
      { receiveIdType: "open_id", receiveId: "ou_loop", body: card },
      { domain: "http://127.0.0.1:1", cache: new DefaultCache(), timeoutMs: 3000 },
    );
    expect(res).toMatchObject({ ok: false, retryable: true });
  });
});

describe("sendCard — idempotency key", () => {
  const send = (h: ReturnType<typeof makeHttp>, body: Record<string, unknown>, idempotencyKey?: string) =>
    sendCard(fixtureConnector(), fixtureSecrets(), { receiveIdType: "open_id", receiveId: "ou_abc", body, idempotencyKey }, overrides(h));

  it("sends the delivery's key as the platform uuid, whatever the card content is", async () => {
    const h = makeHttp();
    const key = "7d1f2a50-1c3e-4b8e-9a77-0f4d2c1b9e10"; // a delivery id (36 chars)
    await send(h, card, key);
    await send(h, { ...card, body: { elements: [{ tag: "div", text: "a fresh token changed the content" }] } }, key);
    await send(h, card, "another-delivery");
    const uuids = h.calls.map((c) => String(c.data?.uuid));
    expect(uuids[0]).toBe(key);
    expect(uuids[1]).toBe(key); // same delivery, different bytes: still ONE message at the platform
    expect(uuids[2]).toBe("another-delivery");
  });

  it("clips an over-long key to the platform's 50 characters and ignores a blank one", async () => {
    const h = makeHttp();
    await send(h, card, "k".repeat(80));
    await send(h, card, "   ");
    const uuids = h.calls.map((c) => String(c.data?.uuid));
    expect(uuids[0]).toBe("k".repeat(50));
    expect(uuids[1]).toHaveLength(50); // fell back to the content-derived key
    expect(uuids[1]).not.toBe("   ");
  });
});

describe("withRequestTimeout", () => {
  it("adds the timeout to every call the SDK can make, and lets a caller's own value win", async () => {
    const seen: { method: string; opts?: { timeout?: number } }[] = [];
    const record = (method: string) => async (...args: unknown[]) => {
      seen.push({ method, opts: args[args.length - 1] as { timeout?: number } });
      return { method };
    };
    const base = {
      request: record("request"),
      get: record("get"),
      delete: record("delete"),
      head: record("head"),
      options: record("options"),
      post: record("post"),
      put: record("put"),
      patch: record("patch"),
    } as unknown as Parameters<typeof withRequestTimeout>[0];

    const http = withRequestTimeout(base, 4000);
    await http.request({ url: "/a" });
    await http.get("/b");
    await http.delete("/c", { headers: {} });
    await http.head("/d");
    await http.options("/e");
    await http.post("/f", { x: 1 });
    await http.put("/g", { x: 1 });
    await http.patch("/h", { x: 1 }, { timeout: 99 });

    expect(seen.map((s) => s.method)).toEqual(["request", "get", "delete", "head", "options", "post", "put", "patch"]);
    expect(seen.slice(0, 7).every((s) => s.opts?.timeout === 4000)).toBe(true);
    expect(seen[7].opts?.timeout).toBe(99);
  });
});

describe("a slow platform call is aborted, not just abandoned", () => {
  let server: Server;
  let base = "";
  const closed: Promise<void>[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.on("data", () => undefined);
      req.on("end", () => {
        if (req.url?.includes("tenant_access_token")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "t-slow", expire: 7200 }));
          return;
        }
        // the message call: never answer; note when the client hangs up
        closed.push(new Promise<void>((resolve) => res.on("close", () => resolve())));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("returns a retryable network error and closes the socket", async () => {
    const res = await sendCard(
      fixtureConnector(),
      fixtureSecrets(),
      { receiveIdType: "open_id", receiveId: "ou_slow", body: card, idempotencyKey: "slow-delivery" },
      { domain: base, cache: new DefaultCache(), timeoutMs: 300 },
    );

    expect(res).toMatchObject({ ok: false, retryable: true });
    expect(closed).toHaveLength(1);
    // The client hung up: the server sees the connection close well within a second.
    await expect(Promise.race([closed[0].then(() => "closed"), new Promise((r) => setTimeout(() => r("still open"), 2000))])).resolves.toBe(
      "closed",
    );
  });
});

describe("the tenant-token cache is per connector (a wrong secret cannot ride another workspace's token)", () => {
  let server: Server;
  let base = "";
  let tokenCalls = 0;
  const GOOD = "secret-of-workspace-A";

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url?.includes("tenant_access_token")) {
          tokenCalls += 1;
          const secret = (JSON.parse(raw || "{}") as { app_secret?: string }).app_secret;
          res.end(
            JSON.stringify(
              secret === GOOD
                ? { code: 0, msg: "ok", tenant_access_token: "t-workspace-a", expire: 7200 }
                : { code: 10003, msg: "invalid param" },
            ),
          );
          return;
        }
        res.end(JSON.stringify({ code: 0, msg: "success", data: { message_id: "om_cache" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const msg = { receiveIdType: "open_id" as const, receiveId: "ou_cache", body: card };
  const A = () => fixtureConnector({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  const B = () => fixtureConnector({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }); // same app id as A
  const send = (connector: ReturnType<typeof fixtureConnector>, appSecret: string) =>
    sendCard(connector, fixtureSecrets({ appSecret }), msg, { domain: base });

  it("reuses a connector's own token across calls (one token fetch for two sends)", async () => {
    tokenCalls = 0;
    expect(await send(A(), GOOD)).toMatchObject({ ok: true });
    expect(await send(A(), GOOD)).toMatchObject({ ok: true });
    expect(tokenCalls).toBe(1);
  });

  it("does NOT let a second connector with the same app id and a WRONG secret use the first one's token", async () => {
    expect(await send(A(), GOOD)).toMatchObject({ ok: true }); // A is warm
    tokenCalls = 0;

    const res = await send(B(), "a-wrong-secret");

    expect(res).toMatchObject({ ok: false, retryable: false });
    expect(tokenCalls).toBe(1); // B went to the platform with ITS credentials and was refused
  });

  it("does not let the test-connection check be fooled either", async () => {
    expect(await send(A(), GOOD)).toMatchObject({ ok: true });
    const fooled = await testBot(B(), fixtureSecrets({ appSecret: "a-wrong-secret" }), { domain: base });
    expect(fooled.ok).toBe(false);
  });

  it("a connector whose secret changed starts a clean cache (the old secret's token is not reused)", async () => {
    const connector = fixtureConnector({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    expect(await send(connector, GOOD)).toMatchObject({ ok: true });
    expect(await send(connector, "rotated-wrong-secret")).toMatchObject({ ok: false });
  });
});

/**
 * Updatable-card / edit-window behaviour of patchCard, and the TEST-ONLY API
 * base override (NOPM_LARK_API_BASE_OVERRIDE). Kept apart from client.test.ts so
 * that file stays about the happy path and error classification.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { DefaultCache } from "@larksuiteoapi/node-sdk";
import { LarkOverrideError, patchCard, resolveApiBaseOverride, sendCard, testBot, type ClientOverrides } from "./client";
import { fixtureConnector, fixtureSecrets } from "./fixtures";

type Call = { url?: string; method?: string; data?: Record<string, unknown> };

/** In-memory HTTP double (no request leaves the process). */
function makeHttp(onRequest: (call: Call) => unknown = () => ({ code: 0, msg: "ok", data: {} })) {
  const calls: Call[] = [];
  const http = {
    request: async (call: Call) => {
      calls.push(call);
      return onRequest(call);
    },
    post: async () => ({ code: 0, tenant_access_token: "t-double", expire: 7200 }),
  };
  return { http: http as unknown as ClientOverrides["httpInstance"], calls };
}

const overrides = (h: ReturnType<typeof makeHttp>): ClientOverrides => ({ httpInstance: h.http, cache: new DefaultCache() });

/** What axios throws for a non-2xx response. */
function axiosError(status: number, data: unknown) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, response: { status, data, headers: {} } });
}

const card = { schema: "2.0", config: { update_multi: true }, header: { title: { tag: "plain_text", content: "hello" } }, body: { elements: [] } };

afterEach(() => vi.unstubAllEnvs());

describe("patchCard - updatable cards and the edit window", () => {
  it("refuses a card that is not shared (update_multi) without calling the platform", async () => {
    const h = makeHttp();
    const notShared = { schema: "1.0", config: { update_multi: false }, elements: [] };
    const res = await patchCard(fixtureConnector(), fixtureSecrets(), "om_x", notShared, overrides(h));
    expect(res).toEqual({ ok: false, retryable: false, error: "card is not updatable (config.update_multi must be true)" });
    expect(h.calls).toHaveLength(0);
    // A 1.0 card that merely omits the flag is not shared either.
    expect(await patchCard(fixtureConnector(), fixtureSecrets(), "om_x", { elements: [] }, overrides(h))).toMatchObject({
      ok: false,
      retryable: false,
    });
  });

  it("accepts a 2.0 card (always shared) and sends update_multi:true to the platform", async () => {
    const h = makeHttp();
    expect(await patchCard(fixtureConnector(), fixtureSecrets(), "om_x", card, overrides(h))).toEqual({ ok: true, externalMessageId: "om_x" });
    expect(JSON.parse(String(h.calls[0].data?.content)).config.update_multi).toBe(true);
  });

  it("an expired edit window (230031) is permanent and says why", async () => {
    const h = makeHttp(() => {
      throw axiosError(400, { code: 230031, msg: "Message can only be modified within 14 days after sending." });
    });
    const res = await patchCard(fixtureConnector(), fixtureSecrets(), "om_old", card, overrides(h));
    expect(res).toMatchObject({ ok: false, retryable: false });
    expect((res as { error: string }).error).toContain("230031");
    expect((res as { error: string }).error).toContain("14 days");
  });

  it("the same code arriving as HTTP 200 is permanent too", async () => {
    const h = makeHttp(() => ({ code: 230031, msg: "too old" }));
    expect(await patchCard(fixtureConnector(), fixtureSecrets(), "om_old", card, overrides(h))).toMatchObject({ ok: false, retryable: false });
  });

  it("names the other permanent patch failures", async () => {
    const hints: Record<number, string> = { 230011: "recalled", 230110: "deleted", 232009: "dissolved", 230013: "availability scope" };
    for (const [code, word] of Object.entries(hints)) {
      const h = makeHttp(() => ({ code: Number(code), msg: "gone" }));
      const res = await patchCard(fixtureConnector(), fixtureSecrets(), "om_x", card, overrides(h));
      expect(res).toMatchObject({ ok: false, retryable: false });
      expect((res as { error: string }).error).toContain(word);
    }
  });

  it("a 5xx or rate limit while patching is still retryable", async () => {
    const five = makeHttp(() => {
      throw axiosError(502, "bad gateway");
    });
    expect(await patchCard(fixtureConnector(), fixtureSecrets(), "om_x", card, overrides(five))).toMatchObject({ ok: false, retryable: true });
    const limited = makeHttp(() => {
      throw axiosError(429, { code: 230020, msg: "freq" });
    });
    expect(await patchCard(fixtureConnector(), fixtureSecrets(), "om_x", card, overrides(limited))).toMatchObject({ ok: false, retryable: true });
  });
});

describe("resolveApiBaseOverride (test-only guard)", () => {
  const env = (extra: Record<string, string | undefined>) => ({ NODE_ENV: "development", ...extra });

  it("is off when unset or blank", () => {
    expect(resolveApiBaseOverride(env({}))).toBeNull();
    expect(resolveApiBaseOverride(env({ NOPM_LARK_API_BASE_OVERRIDE: "   " }))).toBeNull();
  });

  it.each([
    ["http://127.0.0.1:4010", "http://127.0.0.1:4010"],
    ["http://127.0.0.1", "http://127.0.0.1"],
    ["http://localhost:8080", "http://localhost:8080"],
    ["http://LOCALHOST:8080/", "http://localhost:8080"],
    ["  http://127.0.0.1:4010  ", "http://127.0.0.1:4010"],
  ])("accepts %s", (raw, expected) => {
    expect(resolveApiBaseOverride(env({ NOPM_LARK_API_BASE_OVERRIDE: raw }))).toBe(expected);
  });

  it.each([
    "https://127.0.0.1:4010",
    "https://open.larksuite.com",
    "http://open.larksuite.com",
    "http://localhost.evil.test",
    "http://127.0.0.1.evil.test",
    "http://127.0.0.1@evil.test",
    "http://user:pw@127.0.0.1:4010",
    "http://127.0.0.1:4010/some/path",
    "http://127.0.0.1:4010/?x=1",
    "http://127.0.0.1:4010/#frag",
    "http://0.0.0.0:4010",
    "http://10.0.0.5:4010",
    "http://[::1]:4010",
    "ftp://127.0.0.1",
    "127.0.0.1:4010",
    "not a url",
  ])("rejects %s with a permanent error instead of falling back to the real platform", (raw) => {
    expect(() => resolveApiBaseOverride(env({ NOPM_LARK_API_BASE_OVERRIDE: raw }))).toThrow(LarkOverrideError);
  });

  it("is ignored entirely in production, even when set to junk", () => {
    expect(resolveApiBaseOverride({ NODE_ENV: "production", NOPM_LARK_API_BASE_OVERRIDE: "http://127.0.0.1:4010" })).toBeNull();
    expect(resolveApiBaseOverride({ NODE_ENV: "production", NOPM_LARK_API_BASE_OVERRIDE: "https://evil.test" })).toBeNull();
  });

  it("can be re-enabled in production only with NOPM_ALLOW_LARK_OVERRIDE=1, and is still validated", () => {
    const prod = { NODE_ENV: "production", NOPM_ALLOW_LARK_OVERRIDE: "1" };
    expect(resolveApiBaseOverride({ ...prod, NOPM_LARK_API_BASE_OVERRIDE: "http://127.0.0.1:4010" })).toBe("http://127.0.0.1:4010");
    expect(() => resolveApiBaseOverride({ ...prod, NOPM_LARK_API_BASE_OVERRIDE: "https://evil.test" })).toThrow(LarkOverrideError);
    // Only the exact value "1" counts.
    expect(
      resolveApiBaseOverride({ NODE_ENV: "production", NOPM_ALLOW_LARK_OVERRIDE: "true", NOPM_LARK_API_BASE_OVERRIDE: "http://127.0.0.1:4010" }),
    ).toBeNull();
  });
});

describe("the env override end to end (fake Lark on loopback)", () => {
  type Seen = { method?: string; url?: string; auth?: string };
  let server: Server;
  let base = "";
  const seen: Seen[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.on("data", () => undefined);
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
        const url = req.url ?? "";
        const reply = url.includes("tenant_access_token")
          ? { code: 0, msg: "ok", tenant_access_token: "t-fake", expire: 7200 }
          : url.includes("/bot/v3/info")
            ? { code: 0, msg: "ok", bot: { app_name: "Fake Bot", open_id: "ou_fake_bot" } }
            : req.method === "PATCH"
              ? { code: 0, msg: "success", data: {} }
              : { code: 0, msg: "success", data: { message_id: "om_fake_1" } };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const msg = { receiveIdType: "open_id" as const, receiveId: "ou_fake", body: card };

  it("routes token, send, patch and bot info through the override instead of the platform domain", async () => {
    vi.stubEnv("NOPM_LARK_API_BASE_OVERRIDE", base);
    seen.length = 0;
    const cache = { cache: new DefaultCache() };
    expect(await sendCard(fixtureConnector(), fixtureSecrets(), msg, cache)).toEqual({ ok: true, externalMessageId: "om_fake_1" });
    expect(await patchCard(fixtureConnector(), fixtureSecrets(), "om_fake_1", card, cache)).toEqual({ ok: true, externalMessageId: "om_fake_1" });
    expect(await testBot(fixtureConnector(), fixtureSecrets(), cache)).toEqual({ ok: true, botName: "Fake Bot" });
    expect(seen.map((s) => `${s.method} ${s.url?.split("?")[0]}`)).toEqual([
      "POST /open-apis/auth/v3/tenant_access_token/internal",
      "POST /open-apis/im/v1/messages",
      "PATCH /open-apis/im/v1/messages/om_fake_1",
      "GET /open-apis/bot/v3/info",
    ]);
    expect(seen[1].auth).toBe("Bearer t-fake");
  });

  it("an invalid override fails the call permanently and sends nothing", async () => {
    vi.stubEnv("NOPM_LARK_API_BASE_OVERRIDE", "https://open.larksuite.com");
    seen.length = 0;
    const cache = { cache: new DefaultCache() };
    for (const res of [
      await sendCard(fixtureConnector(), fixtureSecrets(), msg, cache),
      await patchCard(fixtureConnector(), fixtureSecrets(), "om_x", card, cache),
    ]) {
      expect(res).toMatchObject({ ok: false, retryable: false });
      expect((res as { error: string }).error).toContain("NOPM_LARK_API_BASE_OVERRIDE");
    }
    expect(await testBot(fixtureConnector(), fixtureSecrets(), cache)).toMatchObject({ ok: false });
    expect(seen).toHaveLength(0);
  });
});

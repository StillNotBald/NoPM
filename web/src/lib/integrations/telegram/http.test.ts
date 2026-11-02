import { describe, it, expect, vi, afterEach } from "vitest";
import {
  answerCallbackQuery,
  callTelegram,
  deleteMyCommands,
  editMessageText,
  isPlausibleBotToken,
  redact,
  sendMessage,
  setMyCommands,
  setWebhook,
} from "./http";
import { FIXTURE_BOT_TOKEN } from "./fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const stubFetch = (impl: (url: string, init: RequestInit) => Promise<Response> | Response) => {
  const f = vi.fn(async (url: string, init: RequestInit) => impl(url, init));
  vi.stubGlobal("fetch", f);
  return f;
};
const okJson = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });

describe("token redaction", () => {
  it("removes the exact token and anything token-shaped", () => {
    const text = `failed https://api.telegram.org/bot${FIXTURE_BOT_TOKEN}/sendMessage and 987654:OTHERtokenvalue`;
    const out = redact(text, FIXTURE_BOT_TOKEN);
    expect(out).not.toContain(FIXTURE_BOT_TOKEN);
    expect(out).not.toContain("987654:OTHERtokenvalue");
    expect(out).toContain("[redacted]");
  });

  it("a failed call never carries the token in its error", async () => {
    stubFetch(() => {
      throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${FIXTURE_BOT_TOKEN}/getMe`);
    });
    const res = await callTelegram(FIXTURE_BOT_TOKEN, "getMe");
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain(FIXTURE_BOT_TOKEN);
  });

  it("an API error description that echoes the token is scrubbed", async () => {
    stubFetch(() => new Response(JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized ${FIXTURE_BOT_TOKEN}` }), { status: 401 }));
    const res = await callTelegram(FIXTURE_BOT_TOKEN, "getMe");
    expect(res).toMatchObject({ ok: false, status: 401, retryable: false });
    expect(JSON.stringify(res)).not.toContain(FIXTURE_BOT_TOKEN);
  });
});

describe("callTelegram", () => {
  it("posts JSON to the bot URL and returns the result", async () => {
    const f = stubFetch(() => okJson({ message_id: 9 }));
    const res = await sendMessage(FIXTURE_BOT_TOKEN, { chatId: 5, text: "hi <b>x</b>", keyboard: [[{ text: "Go", callback_data: "y:1" }]] });
    expect(res).toEqual({ ok: true, result: { message_id: 9 } });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${FIXTURE_BOT_TOKEN}/sendMessage`);
    expect(JSON.parse(String(init.body))).toMatchObject({ chat_id: 5, parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Go", callback_data: "y:1" }]] } });
  });

  it("times out instead of hanging", async () => {
    vi.useFakeTimers();
    stubFetch(
      (_u, init) =>
        new Promise((_r, reject) => {
          init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    const pending = callTelegram(FIXTURE_BOT_TOKEN, "getMe", {}, { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    const res = await pending;
    expect(res).toMatchObject({ ok: false, retryable: true, error: "Telegram did not answer in time" });
  });

  it("marks 429 and 5xx retryable, other 4xx not", async () => {
    stubFetch(() => new Response(JSON.stringify({ ok: false, description: "Too Many Requests" }), { status: 429 }));
    expect(await callTelegram(FIXTURE_BOT_TOKEN, "x")).toMatchObject({ retryable: true });
    stubFetch(() => new Response("oops", { status: 502 }));
    expect(await callTelegram(FIXTURE_BOT_TOKEN, "x")).toMatchObject({ retryable: true, status: 502 });
    stubFetch(() => new Response(JSON.stringify({ ok: false, description: "Bad Request" }), { status: 400 }));
    expect(await callTelegram(FIXTURE_BOT_TOKEN, "x")).toMatchObject({ retryable: false });
  });
});

describe("the six methods", () => {
  it("editMessageText, answerCallbackQuery, setWebhook, setMyCommands and deleteMyCommands send the documented fields", async () => {
    const f = stubFetch(() => okJson(true));
    await editMessageText(FIXTURE_BOT_TOKEN, { chatId: 5, messageId: 7, text: "t" });
    await answerCallbackQuery(FIXTURE_BOT_TOKEN, "cbq", "x".repeat(500));
    await setWebhook(FIXTURE_BOT_TOKEN, "https://nopm.example.test/hook", "sekret_0123");
    await setMyCommands(FIXTURE_BOT_TOKEN, [{ command: "1", description: "My work" }], { type: "chat", chat_id: 5 });
    await deleteMyCommands(FIXTURE_BOT_TOKEN, { type: "chat", chat_id: 5 });
    const calls = f.mock.calls.map(([url, init]) => ({ method: String(url).split("/").pop(), body: JSON.parse(String(init.body)) }));
    expect(calls[0]).toMatchObject({ method: "editMessageText", body: { chat_id: 5, message_id: 7 } });
    expect(calls[1].body.text).toHaveLength(200);
    expect(calls[2]).toMatchObject({ method: "setWebhook", body: { url: "https://nopm.example.test/hook", secret_token: "sekret_0123", allowed_updates: ["message", "callback_query"] } });
    expect(calls[3]).toMatchObject({ method: "setMyCommands", body: { scope: { type: "chat", chat_id: 5 } } });
    expect(calls[4]).toMatchObject({ method: "deleteMyCommands" });
  });
});

describe("isPlausibleBotToken", () => {
  it("accepts BotFather's shape and rejects junk", () => {
    expect(isPlausibleBotToken(FIXTURE_BOT_TOKEN)).toBe(true);
    for (const bad of ["", "abc", "123456", "123456:", "x:y", 5, null, "123456:has space"]) expect(isPlausibleBotToken(bad)).toBe(false);
  });
});

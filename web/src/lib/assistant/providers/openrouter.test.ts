/**
 * OpenRouter provider tests.
 *
 * Covers:
 *  (a) request construction — URL, headers (HTTP-Referer/X-Title), model
 *      passthrough, hard max_tokens cap (2048) — for both chat() and chatStream()
 *  (b) capacity-exhaustion marker — HTTP 429/503 throw OpenRouterCapacityError,
 *      distinguishable via instanceof / error.name, for both chat() and chatStream()
 *  (c) NEVER leak the raw upstream response body into a thrown error message,
 *      for capacity errors AND other non-OK statuses
 *  (d) providers/index.ts dispatch routes provider: "openrouter" correctly
 *
 * No live network calls — fetch is mocked throughout.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { chat, chatStream, OpenRouterCapacityError } from "./openrouter";
import { chat as dispatchChat } from "./index";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function okChatCompletion(content: string) {
  return jsonResponse(200, {
    choices: [{ message: { content, tool_calls: undefined }, finish_reason: "stop" }],
  });
}

/** A leaked-looking body — must NEVER appear in any thrown error message. */
const SECRET_LEAK_BODY = 'rate limited — key fragment "sk-or-v1-abcd1234" exceeded quota, retry after 30s';

// ---------------------------------------------------------------------------
// (a) Request construction — chat()
// ---------------------------------------------------------------------------
describe("openrouter.chat — request construction", () => {
  it("POSTs to the OpenRouter chat-completions endpoint with the required headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okChatCompletion("hi there"));
    vi.stubGlobal("fetch", fetchMock);

    await chat({
      apiKey: "sk-test-key",
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      system: "system prompt",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer sk-test-key");
    expect(headers["HTTP-Referer"]).toBe("https://stillnotbald.com");
    expect(headers["X-Title"]).toBe("NoPM");
  });

  it("passes the model through verbatim and caps max_tokens at 2048", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okChatCompletion("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await chat({
      apiKey: "sk-test-key",
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      system: "system prompt",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { model: string; max_tokens: number };
    expect(body.model).toBe("nvidia/nemotron-3-super-120b-a12b:free");
    expect(body.max_tokens).toBe(2048);
  });

  it("attaches an AbortSignal-based timeout to the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okChatCompletion("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await chat({
      apiKey: "sk-test-key",
      model: "m",
      system: "s",
      messages: [],
      tools: [],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends tool definitions in OpenAI function-calling shape when tools are provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okChatCompletion("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await chat({
      apiKey: "sk-test-key",
      model: "m",
      system: "s",
      messages: [],
      tools: [{ name: "list_projects", description: "List projects", parameters: { type: "object" } }],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      tools: Array<{ type: string; function: { name: string } }>;
      tool_choice: string;
    };
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({ type: "function", function: { name: "list_projects" } });
    expect(body.tool_choice).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// (a) Request construction — chatStream()
// ---------------------------------------------------------------------------
describe("openrouter.chatStream — request construction", () => {
  function sseBody(chunks: string[]): string {
    const lines = chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}`);
    lines.push("data: [DONE]");
    return lines.join("\n") + "\n";
  }

  it("POSTs to the OpenRouter endpoint with stream:true, required headers, and capped max_tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(sseBody(["Hel", "lo"]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const chunks: string[] = [];
    for await (const chunk of chatStream({
      apiKey: "sk-test-key",
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("Hello");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");

    const headers = init.headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBe("https://stillnotbald.com");
    expect(headers["X-Title"]).toBe("NoPM");

    const body = JSON.parse(init.body as string) as { stream: boolean; max_tokens: number; model: string };
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(2048);
    expect(body.model).toBe("nvidia/nemotron-3-super-120b-a12b:free");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// (b) + (c) Capacity-exhaustion marker + no body leak — chat()
// ---------------------------------------------------------------------------
describe("openrouter.chat — capacity exhaustion (429/503) and body-leak safety", () => {
  it("throws OpenRouterCapacityError on HTTP 429, distinguishable via instanceof and .name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(SECRET_LEAK_BODY, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await chat({ apiKey: "k", model: "m", system: "s", messages: [], tools: [] });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(OpenRouterCapacityError);
    expect((caught as Error).name).toBe("OpenRouterCapacityError");
    expect((caught as OpenRouterCapacityError).status).toBe(429);
  });

  it("throws OpenRouterCapacityError on HTTP 503", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(SECRET_LEAK_BODY, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      chat({ apiKey: "k", model: "m", system: "s", messages: [], tools: [] }),
    ).rejects.toMatchObject({ name: "OpenRouterCapacityError" });
  });

  it("never includes the raw upstream response body in the 429 error message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(SECRET_LEAK_BODY, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    let caught: Error | undefined;
    try {
      await chat({ apiKey: "k", model: "m", system: "s", messages: [], tools: [] });
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain(SECRET_LEAK_BODY);
    expect(caught!.message).not.toContain("sk-or-v1-abcd1234");
    expect(caught!.message).toContain("429");
  });

  it("never includes the raw upstream response body for other non-OK statuses (e.g. 401)", async () => {
    const bodyWithSecret = 'invalid credentials for key "sk-or-v1-abcd1234"';
    const fetchMock = vi.fn().mockResolvedValue(new Response(bodyWithSecret, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    let caught: Error | undefined;
    try {
      await chat({ apiKey: "k", model: "m", system: "s", messages: [], tools: [] });
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(OpenRouterCapacityError);
    expect(caught!.message).not.toContain(bodyWithSecret);
    expect(caught!.message).not.toContain("sk-or-v1-abcd1234");
    expect(caught!.message).toContain("401");
  });

  it("never reads the response body at all on a non-OK response (text() is not called)", async () => {
    const textSpy = vi.fn().mockResolvedValue(SECRET_LEAK_BODY);
    const fakeResponse = {
      ok: false,
      status: 429,
      text: textSpy,
      json: vi.fn(),
      body: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      chat({ apiKey: "k", model: "m", system: "s", messages: [], tools: [] }),
    ).rejects.toMatchObject({ name: "OpenRouterCapacityError" });

    expect(textSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (b) + (c) Capacity-exhaustion marker + no body leak — chatStream()
// ---------------------------------------------------------------------------
describe("openrouter.chatStream — capacity exhaustion (429) and body-leak safety", () => {
  it("throws OpenRouterCapacityError on HTTP 429 without leaking the response body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(SECRET_LEAK_BODY, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    let caught: Error | undefined;
    try {
      const iter = chatStream({ apiKey: "k", model: "m", system: "s", messages: [] });
      for await (const _chunk of iter) {
        // drain — should throw before yielding anything
      }
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeInstanceOf(OpenRouterCapacityError);
    expect(caught!.message).not.toContain(SECRET_LEAK_BODY);
    expect(caught!.message).not.toContain("sk-or-v1-abcd1234");
  });
});

// ---------------------------------------------------------------------------
// (d) providers/index.ts dispatch
// ---------------------------------------------------------------------------
describe("providers/index dispatch — openrouter", () => {
  it("routes provider: 'openrouter' to the OpenRouter endpoint via chat()", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okChatCompletion("dispatched"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await dispatchChat({
      provider: "openrouter",
      apiKey: "sk-test-key",
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      system: "sys",
      messages: [],
      tools: [],
    });

    expect(result.text).toBe("dispatched");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
  });
});

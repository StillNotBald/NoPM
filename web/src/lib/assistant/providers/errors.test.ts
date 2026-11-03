import { describe, it, expect, vi, afterEach } from "vitest";
import { ProviderError, kindForStatus, providerErrorMessage, toProviderError } from "./errors";
import { chat, chatStream } from "./index";

afterEach(() => vi.unstubAllGlobals());

describe("provider error kinds (A2)", () => {
  it("maps HTTP status to a kind", () => {
    expect(kindForStatus(401)).toBe("key_invalid");
    expect(kindForStatus(403)).toBe("key_invalid");
    expect(kindForStatus(404)).toBe("model_not_found");
    expect(kindForStatus(429)).toBe("rate_limited");
    expect(kindForStatus(504)).toBe("timeout");
    expect(kindForStatus(500)).toBe("unavailable");
    expect(kindForStatus(503)).toBe("unavailable");
  });

  it("normalises timeouts and network failures, passes typed errors through", () => {
    expect(toProviderError("openai", Object.assign(new Error("x"), { name: "TimeoutError" })).kind).toBe("timeout");
    expect(toProviderError("openai", new TypeError("fetch failed")).kind).toBe("unavailable");
    const typed = new ProviderError("key_invalid", 401, "openai");
    expect(toProviderError("openai", typed)).toBe(typed);
  });

  it("client messages name the provider and the fix, with no upstream text", () => {
    expect(providerErrorMessage("key_invalid", "anthropic")).toContain("Anthropic key was rejected");
    expect(providerErrorMessage("rate_limited", "openai")).toContain("rate limiting");
    expect(providerErrorMessage("model_not_found", "google")).toContain("model");
  });

  it("a demo visitor gets no key or settings advice they cannot act on", () => {
    for (const kind of ["key_invalid", "model_not_found", "rate_limited", "timeout", "unavailable"] as const) {
      const msg = providerErrorMessage(kind, "openrouter", { demo: true });
      expect(msg, kind).toContain("demo model");
      expect(msg, kind).not.toMatch(/key|settings|OpenRouter/i);
    }
  });
});

describe.each(["openai", "anthropic", "google", "openrouter"] as const)("provider router, %s", (provider) => {
  const opts = { provider, apiKey: "sk-secret-key", model: "m", system: "s", messages: [{ role: "user" as const, content: "hi" }] };

  it.each([
    [401, "key_invalid"],
    [404, "model_not_found"],
    [429, "rate_limited"],
    [500, "unavailable"],
  ])("HTTP %i becomes %s without the upstream body", async (status, kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("echoed sk-secret-key and the prompt", { status })));
    const err = (await chat({ ...opts, tools: [] }).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
    expect(err.message).not.toContain("sk-secret-key");

    const streamErr = (await (async () => {
      try {
        for await (const _ of chatStream(opts)) void _;
      } catch (e) {
        return e;
      }
    })()) as ProviderError;
    expect(streamErr).toBeInstanceOf(ProviderError);
    expect(streamErr.kind).toBe(kind);
  });

  it("a timeout becomes kind timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }));
    const err = (await chat({ ...opts, tools: [] }).catch((e) => e)) as ProviderError;
    expect(err.kind).toBe("timeout");
  });
});

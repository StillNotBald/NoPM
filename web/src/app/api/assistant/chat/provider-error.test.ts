/**
 * A2: a provider failure is never silent. The route logs the kind (no secrets),
 * tells the client why, and the read-only fallback still answers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { ProviderError } from "@/lib/assistant/providers/errors";

const m = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  resolveProvider: vi.fn(),
  chargeTurnQuota: vi.fn(),
  hasOwnCredential: vi.fn(),
  refundTurnQuota: vi.fn(),
  runAssistant: vi.fn(),
  runAssistantStream: vi.fn(),
  runAssistantFallback: vi.fn(),
  isDemoActor: vi.fn(async () => true),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/api/rate-limit", () => ({ checkRateLimit: async () => {} }));
vi.mock("@/lib/auth/demo", () => ({ isDemoActor: m.isDemoActor }));
vi.mock("@/lib/auth/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guard")>()),
  requireAuth: m.requireAuth,
}));
vi.mock("@/lib/assistant/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant/index")>()),
  resolveProvider: m.resolveProvider,
  chargeTurnQuota: m.chargeTurnQuota,
  hasOwnCredential: m.hasOwnCredential,
  refundTurnQuota: m.refundTurnQuota,
  runAssistant: m.runAssistant,
  runAssistantStream: m.runAssistantStream,
}));
vi.mock("@/lib/assistant/fallback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant/fallback")>()),
  runAssistantFallback: m.runAssistantFallback,
}));

import { POST } from "./route";

const actor: Actor = { type: "user", id: "u1", label: "Pat", workspaceId: "w1", role: "member", principalId: "u1" };
const RESOLVED = { provider: "openai", apiKey: "sk-secret-key", model: "m", usedDemoKey: false };

function chat(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://x.example/api/assistant/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello", ...body }),
    }),
    { params: Promise.resolve({}) },
  );
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://nopm.example");
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const fn of Object.values(m)) fn.mockReset();
  m.isDemoActor.mockResolvedValue(true);
  m.requireAuth.mockResolvedValue(actor);
  m.resolveProvider.mockResolvedValue(RESOLVED);
  m.chargeTurnQuota.mockResolvedValue(undefined);
  m.hasOwnCredential.mockResolvedValue(true);
  m.refundTurnQuota.mockResolvedValue(undefined);
  m.runAssistantFallback.mockImplementation(async () => ({
    reply: "fallback reply",
    actions: [],
    usedFallback: true,
    usedDemoKey: false,
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("provider failures are visible (A2)", () => {
  it("JSON path: a rejected key is logged by kind and sent to the client as provider_error", async () => {
    m.runAssistant.mockRejectedValue(new ProviderError("key_invalid", 401, "openai"));
    const res = await chat({});
    const body = (await res.json()) as { data?: Record<string, unknown> } & Record<string, unknown>;
    const payload = (body.data ?? body) as { reply: string; provider_error: { kind: string; message: string } };
    expect(payload.reply).toBe("fallback reply");
    expect(payload.provider_error.kind).toBe("key_invalid");
    expect(payload.provider_error.message).toContain("OpenAI key was rejected");
    expect(errorSpy).toHaveBeenCalledWith(
      "[nopm][assistant] provider error",
      expect.objectContaining({ kind: "key_invalid", provider: "openai", status: 401 }),
    );
    // No secret in anything logged or returned.
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("sk-secret-key");
    expect(JSON.stringify(body)).not.toContain("sk-secret-key");
  });

  it("demo key: the provider_error message is demo copy, with no key or settings advice", async () => {
    m.resolveProvider.mockResolvedValue({ ...RESOLVED, provider: "openrouter", usedDemoKey: true });
    m.runAssistant.mockRejectedValue(new ProviderError("model_not_found", 404, "openrouter"));
    const json = await chat({});
    const body = (await json.json()) as { data?: Record<string, unknown> } & Record<string, unknown>;
    const msg = ((body.data ?? body) as { provider_error: { message: string } }).provider_error.message;
    expect(msg).toContain("demo model");
    expect(msg).not.toMatch(/settings|key/i);

    m.runAssistantStream.mockRejectedValue(new ProviderError("model_not_found", 404, "openrouter"));
    const res = await chat({ stream: true });
    const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const done = events.find((e) => e.type === "done") as { provider_error?: { message: string; demo?: boolean; provider: string } };
    expect(done.provider_error?.message).toContain("demo model");
    expect(done.provider_error?.message).not.toMatch(/settings|key/i);
    expect(done.provider_error?.demo).toBe(true);
    expect(done.provider_error?.provider).toBe("demo");
    expect(JSON.stringify(events)).not.toContain("openrouter");
  });

  it("demo key: a mid-stream failure carries demo copy on the error event", async () => {
    m.resolveProvider.mockResolvedValue({ ...RESOLVED, provider: "openrouter", usedDemoKey: true });
    async function* chunks() {
      yield "partial ";
      throw new ProviderError("model_not_found", 404, "openrouter");
    }
    m.runAssistantStream.mockResolvedValue({ actions: [], usedDemoKey: true, textChunks: chunks(), release: async () => {} });
    const res = await chat({ stream: true });
    const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const err = events.find((e) => e.type === "error") as { provider_error?: { message: string; demo?: boolean }; message: string };
    expect(err.provider_error?.demo).toBe(true);
    expect(err.message).toContain("demo model");
    expect(err.message).not.toMatch(/settings|key/i);
  });

  it("own key: provider_error has no demo flag and names the provider", async () => {
    m.runAssistant.mockRejectedValue(new ProviderError("model_not_found", 404, "openai"));
    const res = await chat({});
    const body = (await res.json()) as { data?: Record<string, unknown> } & Record<string, unknown>;
    const pe = ((body.data ?? body) as { provider_error: { demo?: boolean; provider: string } }).provider_error;
    expect(pe.demo).toBeUndefined();
    expect(pe.provider).toBe("openai");
  });

  it("JSON path: an untyped failure is logged by name, with no provider_error", async () => {
    m.runAssistant.mockRejectedValue(new Error("boom with secret sk-secret-key"));
    const res = await chat({});
    const body = (await res.json()) as { data?: Record<string, unknown> } & Record<string, unknown>;
    expect(((body.data ?? body) as Record<string, unknown>).provider_error).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith("[nopm][assistant] turn failed", expect.objectContaining({ error: "Error" }));
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("sk-secret-key");
  });

  it("stream path: a failure before any token puts provider_error on the done event", async () => {
    m.runAssistantStream.mockRejectedValue(new ProviderError("rate_limited", 429, "anthropic"));
    const res = await chat({ stream: true });
    const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const done = events.find((e) => e.type === "done") as { provider_error?: { kind: string }; usedFallback?: boolean };
    expect(done.usedFallback).toBe(true);
    expect(done.provider_error?.kind).toBe("rate_limited");
  });

  it("stream path: a failure after tokens flushed carries provider_error on the error event", async () => {
    async function* chunks() {
      yield "partial ";
      throw new ProviderError("timeout", 0, "google");
    }
    m.runAssistantStream.mockResolvedValue({ actions: [], usedDemoKey: false, textChunks: chunks(), release: async () => {} });
    const res = await chat({ stream: true });
    const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const err = events.find((e) => e.type === "error") as { provider_error?: { kind: string }; message: string };
    expect(err.provider_error?.kind).toBe("timeout");
    expect(err.message).toContain("took too long");
  });
});

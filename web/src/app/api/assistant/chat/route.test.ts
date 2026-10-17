/**
 * POST /api/assistant/chat: the route-level guarantees added in the 2026-10-17 fix wave.
 *  - D-ACC-8  a failed provider turn that already ran tools still reports them
 *  - D-ACC-10 an exhausted demo quota is a 429 + Retry-After, charged once per turn
 *  - A1-10    the streaming path revokes the ephemeral token on every exit
 *  - A1-11    the token is only ever sent to the operator's configured origin
 *  - A1-12    a broken counter store refuses (503) instead of letting the turn through
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api/errors";
import type { Actor } from "@/lib/auth/guard";

const m = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  resolveProvider: vi.fn(),
  chargeTurnQuota: vi.fn(),
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
  runAssistant: m.runAssistant,
  runAssistantStream: m.runAssistantStream,
}));
vi.mock("@/lib/assistant/fallback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant/fallback")>()),
  runAssistantFallback: m.runAssistantFallback,
}));

import { DemoQuotaExceededError, DemoQuotaUnavailableError, type Action } from "@/lib/assistant/index";
import { POST } from "./route";

const actor: Actor = { type: "user", id: "u1", label: "Pat", workspaceId: "w1", role: "member", principalId: "u1" };
const RESOLVED = { provider: "openai", apiKey: "k", model: "m", usedDemoKey: true };
const created: Action = { tool: "create_task", args: {}, ok: true, summary: 'Created task "Ship"' };

function chat(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("http://evil.example/api/assistant/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ message: "do it", ...body }),
    }),
    { params: Promise.resolve({}) },
  );
}

async function readAll(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://nopm.example");
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const fn of Object.values(m)) fn.mockReset();
  m.isDemoActor.mockResolvedValue(true);
  m.requireAuth.mockResolvedValue(actor);
  m.resolveProvider.mockResolvedValue(RESOLVED);
  m.chargeTurnQuota.mockResolvedValue(undefined);
  m.runAssistantFallback.mockImplementation(async (opts: { priorActions?: Action[] }) => ({
    reply: "fallback reply",
    actions: [...(opts.priorActions ?? [])],
    usedFallback: true,
    usedDemoKey: false,
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("origin (A1-11)", () => {
  it("sends the assistant to the configured app origin, never the Host-derived one", async () => {
    m.runAssistant.mockResolvedValue({ reply: "ok", actions: [], usedDemoKey: true });
    const res = await chat({});
    expect(res.status).toBe(200);
    expect(m.runAssistant.mock.calls[0][0].origin).toBe("https://nopm.example");
  });

  it("fails closed (503) when no trustworthy origin exists, before anything runs", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("NODE_ENV", "production");
    const res = await chat({});
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("misconfigured");
    expect(m.resolveProvider).not.toHaveBeenCalled();
    expect(m.runAssistant).not.toHaveBeenCalled();
  });
});

describe("demo quota (D-ACC-10, A1-12)", () => {
  it("an exhausted quota is a 429 with Retry-After, not a 500 or a fallback reply", async () => {
    m.resolveProvider.mockRejectedValue(new DemoQuotaExceededError(1234));
    const res = await chat({});
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1234");
    expect(m.runAssistant).not.toHaveBeenCalled();
    expect(m.runAssistantFallback).not.toHaveBeenCalled();
  });

  it("the same for a streaming request: a real 429 before any stream opens", async () => {
    m.resolveProvider.mockRejectedValue(new DemoQuotaExceededError(60));
    const res = await chat({ stream: true });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("a broken counter store refuses the turn (503), it does not let it through", async () => {
    m.resolveProvider.mockRejectedValue(new DemoQuotaUnavailableError());
    const res = await chat({});
    expect(res.status).toBe(503);
    expect(m.runAssistant).not.toHaveBeenCalled();
  });

  it("no usable provider goes straight to the fallback after ONE quota charge, and a spent quota is a 429", async () => {
    m.resolveProvider.mockRejectedValue(new Error("No AI assistant credentials configured"));
    m.chargeTurnQuota.mockRejectedValueOnce(new DemoQuotaExceededError(30));
    const res = await chat({});
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(m.runAssistantFallback).not.toHaveBeenCalled();
  });

  it("no usable provider with quota left: one charge, then the fallback answers", async () => {
    m.resolveProvider.mockRejectedValue(new Error("no key"));
    const res = await chat({});
    expect(res.status).toBe(200);
    expect(m.chargeTurnQuota).toHaveBeenCalledTimes(1);
    expect(m.runAssistant).not.toHaveBeenCalled();
    expect(m.runAssistantFallback).toHaveBeenCalledTimes(1);
  });

  it("the fallback's rate check shares the turn's quota state (resolve + fallback = one charge)", async () => {
    m.runAssistant.mockRejectedValue(new Error("upstream 500"));
    await chat({});
    const quotaArg = m.runAssistant.mock.calls[0][0].quota;
    expect(quotaArg).toBeDefined();
    const fallbackOpts = m.runAssistantFallback.mock.calls[0][0];
    await fallbackOpts.rateCheck();
    expect(m.chargeTurnQuota.mock.calls[0][2]).toBe(quotaArg);
  });
});

describe("failed provider turn keeps its actions (D-ACC-8)", () => {
  it("passes the already-run actions to the fallback and returns them", async () => {
    m.runAssistant.mockImplementation(async (opts: { actionLog: Action[] }) => {
      opts.actionLog.push(created);
      throw new Error("provider died");
    });
    const res = await chat({});
    const body = (await res.json()) as { data: { actions: Action[]; reply: string } };
    expect(res.status).toBe(200);
    expect(m.runAssistantFallback.mock.calls[0][0].priorActions).toEqual([created]);
    expect(body.data.actions).toEqual([created]);
  });

  it("if the fallback is then refused by the quota, the user still sees what was done", async () => {
    m.runAssistant.mockImplementation(async (opts: { actionLog: Action[] }) => {
      opts.actionLog.push(created);
      throw new Error("provider died");
    });
    m.runAssistantFallback.mockRejectedValue(new DemoQuotaExceededError(10));
    const res = await chat({});
    const body = (await res.json()) as { data: { actions: Action[]; reply: string } };
    expect(res.status).toBe(200);
    expect(body.data.reply).toContain('Created task "Ship"');
    expect(body.data.actions).toEqual([created]);
  });

  it("with nothing done yet, a refused fallback is the 429", async () => {
    m.runAssistant.mockRejectedValue(new Error("provider died"));
    m.runAssistantFallback.mockRejectedValue(new DemoQuotaExceededError(10));
    const res = await chat({});
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("10");
  });

  it("streaming: a failure before the first token falls back with the prior actions", async () => {
    m.runAssistantStream.mockImplementation(async (opts: { actionLog: Action[] }) => {
      opts.actionLog.push(created);
      throw new Error("provider died");
    });
    const res = await chat({ stream: true });
    const events = await readAll(res);
    expect(m.runAssistantFallback.mock.calls[0][0].priorActions).toEqual([created]);
    const actionsEvent = events.filter((e) => e.type === "actions").at(-1)!;
    expect(actionsEvent.actions).toEqual([created]);
    expect(events.at(-1)).toMatchObject({ type: "done", usedFallback: true });
  });
});

describe("streaming token release (A1-10)", () => {
  function streamOf(chunks: string[], release: () => Promise<void>) {
    return {
      actions: [] as Action[],
      usedDemoKey: true,
      textChunks: (async function* () {
        for (const c of chunks) yield c;
      })(),
      release,
    };
  }

  it("releases the token after a normal stream", async () => {
    const release = vi.fn(async () => {});
    m.runAssistantStream.mockResolvedValue(streamOf(["a", "b"], release));
    const res = await chat({ stream: true });
    const events = await readAll(res);
    expect(events.map((e) => e.type)).toEqual(["actions", "token", "token", "done"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the token when the client goes away before iteration starts", async () => {
    const release = vi.fn(async () => {});
    let resolveStream: (v: unknown) => void = () => {};
    m.runAssistantStream.mockImplementation(() => new Promise((r) => (resolveStream = r)));
    const res = await chat({ stream: true });
    await res.body!.cancel(); // client disconnects while the tool rounds are still running
    resolveStream(streamOf(["never read"], release));
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("releases the token when the stream errors mid-reply", async () => {
    const release = vi.fn(async () => {});
    const broken = {
      actions: [] as Action[],
      usedDemoKey: true,
      textChunks: (async function* () {
        yield "partial";
        throw new Error("socket reset");
      })(),
      release,
    };
    m.runAssistantStream.mockResolvedValue(broken);
    const events = await readAll(await chat({ stream: true }));
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("a spent quota inside the open stream is a named error event, not the generic one", async () => {
    m.runAssistantStream.mockRejectedValue(new Error("provider died"));
    m.runAssistantFallback.mockRejectedValue(new DemoQuotaExceededError(77));
    const events = await readAll(await chat({ stream: true }));
    expect(events.at(-1)).toMatchObject({ type: "error", code: "rate_limited", retry_after_seconds: 77 });
  });
});

describe("misc", () => {
  it("rejects token callers", async () => {
    m.requireAuth.mockResolvedValue({ ...actor, type: "token" });
    expect((await chat({})).status).toBe(403);
  });

  it("an ApiError from the quota is passed through untouched", async () => {
    m.resolveProvider.mockRejectedValue(new ApiError(503, "down", "demo_quota_unavailable"));
    const res = await chat({});
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("demo_quota_unavailable");
  });
});

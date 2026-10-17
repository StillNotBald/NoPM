/**
 * Hardening tests for the assistant agentic loop (W2-T2):
 *  - boundHistory caps forwarded history at MAX_HISTORY_MESSAGES (24)
 *  - checkDemoRateLimit stays fail-open on an RPC error, but logs loudly
 *  - the per-turn tool-call cap (MAX_TOOL_CALLS_PER_TURN = 8) actually stops
 *    the agentic loop mid-batch, across multiple provider "steps"
 *
 * No live network/DB/provider calls — ./token, ./providers/index,
 * @/lib/supabase/admin, and @/lib/crypto are mocked; global fetch is
 * stubbed for the tool-execution HTTP calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Actor } from "@/lib/auth/guard";

// ── Hoisted mocks (vi.mock factories run before top-level const) ───────────
const { mintEphemeralToken, revokeEphemeralToken } = vi.hoisted(() => ({
  mintEphemeralToken: vi.fn(async () => ({ raw: "tok_raw", id: "tok_id" })),
  revokeEphemeralToken: vi.fn(async () => {}),
}));

vi.mock("./token", () => ({ mintEphemeralToken, revokeEphemeralToken }));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn(() => "fake-api-key"),
  encrypt: vi.fn((s: string) => s),
}));

const { chat: mockChat, chatStream: mockChatStream } = vi.hoisted(() => ({
  chat: vi.fn(),
  chatStream: vi.fn(async function* () {
    yield "ok";
  }),
}));

vi.mock("./providers/index", () => ({
  chat: mockChat,
  chatStream: mockChatStream,
}));

const { createAdminClient } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));

import { runAssistant, runAssistantStream, buildToolCall, boundHistory, checkDemoRateLimit, MAX_HISTORY_MESSAGES, MAX_TOOL_CALLS_PER_TURN } from "./index";
import { TOOLS } from "./tools";

function testActor(): Actor {
  return { type: "user", id: "usr_1", label: "Test User", workspaceId: "ws_1" };
}

/** A fake admin client whose assistant_credentials lookup returns a BYOK credential. */
function byokAdminClient() {
  return {
    from: (table: string) => {
      if (table !== "assistant_credentials") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { provider: "openrouter", api_key_enc: "enc", model: "test-model" },
              error: null,
            }),
          }),
        }),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// boundHistory — pure
// ---------------------------------------------------------------------------
describe("boundHistory", () => {
  it(`returns the full history unchanged when length <= ${MAX_HISTORY_MESSAGES}`, () => {
    const history = Array.from({ length: 24 }, (_, i) => ({ role: "user" as const, content: `m${i}` }));
    expect(boundHistory(history)).toHaveLength(24);
    expect(boundHistory(history)).toEqual(history);
  });

  it(`keeps only the LAST ${MAX_HISTORY_MESSAGES} messages when history exceeds the cap`, () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ role: "user" as const, content: `m${i}` }));
    const bounded = boundHistory(history);
    expect(bounded).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(bounded[0].content).toBe("m6"); // 30 - 24 = 6 dropped from the front
    expect(bounded[bounded.length - 1].content).toBe("m29");
  });

  it("returns an empty array unchanged for empty history", () => {
    expect(boundHistory([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkDemoRateLimit — fail-open + loud logging
// ---------------------------------------------------------------------------
describe("checkDemoRateLimit", () => {
  it("resolves without throwing when the rate check passes (data: true)", async () => {
    const db = { rpc: vi.fn(async () => ({ data: true, error: null })) } as unknown as Parameters<
      typeof checkDemoRateLimit
    >[0];
    await expect(checkDemoRateLimit(db, "usr_1")).resolves.toBeUndefined();
  });

  it("throws when the limit is exceeded (data: false)", async () => {
    const db = { rpc: vi.fn(async () => ({ data: false, error: null })) } as unknown as Parameters<
      typeof checkDemoRateLimit
    >[0];
    await expect(checkDemoRateLimit(db, "usr_1")).rejects.toThrow(/rate limit/i);
  });

  it("fails OPEN (does not throw) on an RPC error, and logs a loud structured warning", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      rpc: vi.fn(async () => ({ data: null, error: { message: "connection reset" } })),
    } as unknown as Parameters<typeof checkDemoRateLimit>[0];

    await expect(checkDemoRateLimit(db, "usr_1")).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [msg, payload] = errorSpy.mock.calls[0];
    expect(String(msg)).toMatch(/fail(ing)?\s+open/i);
    expect(payload).toMatchObject({ userId: "usr_1", rpc: "nopm_demo_rate_check" });

    errorSpy.mockRestore();
  });

  it("does NOT log when the rate check succeeds normally", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = { rpc: vi.fn(async () => ({ data: true, error: null })) } as unknown as Parameters<
      typeof checkDemoRateLimit
    >[0];

    await checkDemoRateLimit(db, "usr_1");

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Per-turn tool-call cap — integration across multiple provider "steps"
// ---------------------------------------------------------------------------
describe("runAssistant — per-turn tool-call cap", () => {
  beforeEach(() => {
    mintEphemeralToken.mockClear();
    revokeEphemeralToken.mockClear();
    mockChat.mockReset();
    createAdminClient.mockReset();
    createAdminClient.mockReturnValue(byokAdminClient());

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [], total: 0, page: 1, limit: 20 }), { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it(`stops executing tool calls at ${MAX_TOOL_CALLS_PER_TURN} even when the provider keeps requesting more`, async () => {
    // Every provider "step" returns 5 tool calls and NEVER an empty toolCalls
    // array — without the cap this would run until MAX_STEPS (6 steps × 5 =
    // 30 calls). The cap must stop execution at exactly 8.
    mockChat.mockImplementation(async () => ({
      text: null,
      toolCalls: Array.from({ length: 5 }, (_, i) => ({
        id: `call_${Math.random()}_${i}`,
        name: "list_projects",
        args: {},
      })),
      finishReason: "tool_calls",
    }));

    const result = await runAssistant({
      actor: testActor(),
      message: "list everything repeatedly",
      history: [],
      origin: "http://localhost:3000",
    });

    expect(result.actions).toHaveLength(MAX_TOOL_CALLS_PER_TURN);
    expect(result.actions.every((a) => a.tool === "list_projects")).toBe(true);
    expect(result.reply.toLowerCase()).toMatch(/limit|cap|reached/);

    // Cap enforcement must have stopped the loop well before MAX_STEPS (6)
    // would have been exhausted at 5 calls/step (would need only 2 steps to
    // hit 8, so chat() should have been called twice, not 6+ times).
    expect(mockChat).toHaveBeenCalledTimes(2);

    expect(revokeEphemeralToken).toHaveBeenCalledTimes(1);
  });

  it("never exceeds the cap even across the full MAX_STEPS budget with 2 calls/step", async () => {
    mockChat.mockImplementation(async () => ({
      text: null,
      toolCalls: [
        { id: `a_${Math.random()}`, name: "list_projects", args: {} },
        { id: `b_${Math.random()}`, name: "list_projects", args: {} },
      ],
      finishReason: "tool_calls",
    }));

    const result = await runAssistant({
      actor: testActor(),
      message: "list everything repeatedly",
      history: [],
      origin: "http://localhost:3000",
    });

    expect(result.actions.length).toBeLessThanOrEqual(MAX_TOOL_CALLS_PER_TURN);
  });

  it("does not hit the cap for an ordinary turn with a single tool call then a text reply", async () => {
    mockChat
      .mockImplementationOnce(async () => ({
        text: null,
        toolCalls: [{ id: "call_1", name: "list_projects", args: {} }],
        finishReason: "tool_calls",
      }))
      .mockImplementationOnce(async () => ({
        text: "Here are your projects.",
        toolCalls: [],
        finishReason: "stop",
      }));

    const result = await runAssistant({
      actor: testActor(),
      message: "what are my projects?",
      history: [],
      origin: "http://localhost:3000",
    });

    expect(result.actions).toHaveLength(1);
    expect(result.reply).toBe("Here are your projects.");
  });
});

// ---------------------------------------------------------------------------
// A refused tool argument (ToolArgError) is a failed tool RESULT, never an
// aborted turn (R1 M4 follow-up). Model output is untrusted: a hallucinated or
// hostile id must reach the model as an error it can correct, not crash the
// turn and lose the reply and every earlier action.
// ---------------------------------------------------------------------------
describe("runAssistant / runAssistantStream — refused tool arguments", () => {
  const UUID = "00000000-0000-4000-a000-000000000001";
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mintEphemeralToken.mockClear();
    revokeEphemeralToken.mockClear();
    mockChat.mockReset();
    createAdminClient.mockReset();
    createAdminClient.mockReturnValue(byokAdminClient());
    fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: [], total: 0, page: 1, limit: 20 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const hostile = { id: "call_bad", name: "create_milestone", args: { project_id: `${UUID}/../unlock?x=`, name: "M" } };

  it("buildToolCall: returns the request for good arguments and a message (never a throw) for refused ones", () => {
    const spec = TOOLS.find((t) => t.definition.name === "get_project")!;
    expect(buildToolCall(spec, { project_id: UUID })).toEqual({ ok: true, path: `/api/projects/${UUID}`, method: "GET" });
    expect(buildToolCall(spec, { project_id: "../unlock" })).toEqual({ ok: false, message: "Bad arguments: project_id must be a UUID" });
    expect(() => buildToolCall(spec, { project_id: { toString: () => UUID } })).not.toThrow();
  });

  it("runAssistant: the turn survives, the model sees the error, and NO request is made for the refused call", async () => {
    mockChat
      .mockImplementationOnce(async () => ({ text: null, toolCalls: [hostile], finishReason: "tool_calls" }))
      .mockImplementationOnce(async () => ({ text: "I could not use that id.", toolCalls: [], finishReason: "stop" }));

    const result = await runAssistant({ actor: testActor(), message: "go", history: [], origin: "http://localhost:3000" });

    expect(result.reply).toBe("I could not use that id.");
    expect(result.actions).toEqual([
      { tool: "create_milestone", args: hostile.args, ok: false, summary: "Bad arguments: project_id must be a UUID" },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    // The error went back to the model as the tool result, paired with the call id.
    const secondCall = mockChat.mock.calls[1][0] as { messages: { role: string; content: string; tool_call_id?: string }[] };
    const toolMsg = secondCall.messages.find((m) => m.role === "tool")!;
    expect(toolMsg.tool_call_id).toBe("call_bad");
    expect(JSON.parse(toolMsg.content)).toEqual({ error: "Bad arguments: project_id must be a UUID" });
    expect(revokeEphemeralToken).toHaveBeenCalledTimes(1);
  });

  it("runAssistant: one refused call does not stop the good calls beside it, and still counts against the per-turn cap", async () => {
    mockChat
      .mockImplementationOnce(async () => ({
        text: null,
        toolCalls: [hostile, { id: "call_ok", name: "get_project", args: { project_id: UUID } }],
        finishReason: "tool_calls",
      }))
      .mockImplementationOnce(async () => ({ text: "Done.", toolCalls: [], finishReason: "stop" }));

    const result = await runAssistant({ actor: testActor(), message: "go", history: [], origin: "http://localhost:3000" });

    expect(result.actions.map((a) => [a.tool, a.ok])).toEqual([
      ["create_milestone", false],
      ["get_project", true],
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toBe(`http://localhost:3000/api/projects/${UUID}`);

    const secondCall = mockChat.mock.calls[1][0] as { messages: { role: string; tool_call_id?: string }[] };
    expect(secondCall.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(["call_bad", "call_ok"]);
  });

  it("runAssistant: a model that keeps sending refused calls is still bounded by the tool-call cap", async () => {
    mockChat.mockImplementation(async () => ({
      text: null,
      toolCalls: Array.from({ length: 5 }, (_, i) => ({ ...hostile, id: `bad_${Math.random()}_${i}` })),
      finishReason: "tool_calls",
    }));
    const result = await runAssistant({ actor: testActor(), message: "go", history: [], origin: "http://localhost:3000" });
    expect(result.actions).toHaveLength(MAX_TOOL_CALLS_PER_TURN);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runAssistantStream: same behaviour — the turn completes, the refused call is a failed action, no request is made", async () => {
    mockChat
      .mockImplementationOnce(async () => ({ text: null, toolCalls: [hostile], finishReason: "tool_calls" }))
      .mockImplementationOnce(async () => ({ text: "Handled.", toolCalls: [], finishReason: "stop" }));

    const out = await runAssistantStream({ actor: testActor(), message: "go", history: [], origin: "http://localhost:3000" });
    const chunks: string[] = [];
    for await (const c of out.textChunks) chunks.push(c);

    expect(out.actions).toEqual([
      { tool: "create_milestone", args: hostile.args, ok: false, summary: "Bad arguments: project_id must be a UUID" },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(chunks.join("")).not.toBe("");
    expect(revokeEphemeralToken).toHaveBeenCalledTimes(1);
  });
});

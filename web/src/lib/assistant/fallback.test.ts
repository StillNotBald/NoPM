/**
 * Fallback governance tests.
 *
 * Core invariants under test (LOCKED decisions, W2-T2):
 *  (a) the fallback NEVER selects a write tool — every tool it calls is
 *      derived from the registry as GET-only, and never overlaps with the
 *      registry's write tool names (mirrors scopes.test.ts's style of
 *      asserting against TOOLS/TOOL_SCOPES metadata rather than a
 *      hand-maintained list).
 *  (b) `rateCheck` is awaited FIRST — before minting a token or executing
 *      any tool — so the fallback can never bypass the caller's rate limit.
 *  (c) an unmatched message still returns a grounded, non-empty reply (the
 *      "workspace overview + capability hint" default path).
 *  (d) the ephemeral token is minted once and always revoked, even when a
 *      tool call fails.
 *
 * No live network or DB calls — fetch and ./token are mocked throughout.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { Actor } from "@/lib/auth/guard";
import { TOOLS } from "./tools";

// vi.mock is hoisted above imports — any shared mock fns it references must
// be declared via vi.hoisted() so they exist before the factory first runs.
const { mintEphemeralToken, revokeEphemeralToken } = vi.hoisted(() => ({
  mintEphemeralToken: vi.fn(async () => ({ raw: "tok_raw_fallback", id: "tok_id_fallback" })),
  revokeEphemeralToken: vi.fn(async () => {}),
}));

vi.mock("./token", () => ({
  mintEphemeralToken,
  revokeEphemeralToken,
}));

import { runAssistantFallback, FALLBACK_READ_ONLY_TOOLS } from "./fallback";

function testActor(): Actor {
  return { type: "user", id: "usr_demo", label: "Demo Visitor", workspaceId: "ws_demo" };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Route fetch calls by URL substring, in order given (first match wins). */
function routedFetch(routes: Array<[string, unknown]>, calls: string[]) {
  return vi.fn(async (url: string) => {
    calls.push(`fetch:${url}`);
    for (const [needle, body] of routes) {
      if (url.includes(needle)) return jsonResponse(200, body);
    }
    return jsonResponse(404, { error: "unrouted in test" });
  });
}

beforeEach(() => {
  mintEphemeralToken.mockClear();
  revokeEphemeralToken.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// (a) never selects a write tool
// ---------------------------------------------------------------------------
describe("FALLBACK_READ_ONLY_TOOLS — derived from the tool registry", () => {
  const writeToolNames = TOOLS.filter((t) => t.toRequest({}).method !== "GET").map((t) => t.definition.name);
  const readToolNames = TOOLS.filter((t) => t.toRequest({}).method === "GET").map((t) => t.definition.name);

  it("excludes every write tool (create_*, request_task_deletion)", () => {
    expect(writeToolNames.length).toBeGreaterThan(0); // sanity: registry does have write tools
    for (const name of writeToolNames) {
      expect(FALLBACK_READ_ONLY_TOOLS.has(name)).toBe(false);
    }
  });

  it("includes every GET tool in the registry", () => {
    expect(readToolNames.length).toBeGreaterThan(0);
    for (const name of readToolNames) {
      expect(FALLBACK_READ_ONLY_TOOLS.has(name)).toBe(true);
    }
  });

  it("specifically excludes request_task_deletion (a DELETE, not a create_*)", () => {
    expect(FALLBACK_READ_ONLY_TOOLS.has("request_task_deletion")).toBe(false);
  });
});

describe("runAssistantFallback — never selects a write tool, across all intents", () => {
  const writeToolNames = new Set(TOOLS.filter((t) => t.toRequest({}).method !== "GET").map((t) => t.definition.name));

  const messages = [
    "what are the top open risks?",
    "show me recent activity in the audit trail",
    "what's the project status / portfolio overview?",
    "asdkjfh nonsense gibberish message",
  ];

  it.each(messages)('records only read-only tool actions for message: "%s"', async (message) => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      routedFetch(
        [
          ["/api/projects?", { data: [{ id: "p1", name: "Proj One", rag_status: "green" }], total: 1, page: 1, limit: 50 }],
          ["/api/projects/p1/risks", { data: [{ title: "Data breach", status: "open", severity: "critical" }], total: 1, page: 1, limit: 50 }],
          ["/api/audit", { data: [{ action: "project.create", target_type: "project" }], total: 1, page: 1, limit: 5 }],
        ],
        calls,
      ),
    );

    const result = await runAssistantFallback({
      actor: testActor(),
      message,
      origin: "http://localhost:3000",
      rateCheck: async () => {
        calls.push("rateCheck");
      },
    });

    expect(result.usedFallback).toBe(true);
    expect(result.usedDemoKey).toBe(false);
    expect(result.reply.length).toBeGreaterThan(0);

    for (const action of result.actions) {
      expect(FALLBACK_READ_ONLY_TOOLS.has(action.tool)).toBe(true);
      expect(writeToolNames.has(action.tool)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// (b) rateCheck is awaited before any tool execution
// ---------------------------------------------------------------------------
describe("runAssistantFallback — rateCheck ordering", () => {
  it("calls rateCheck before minting a token or executing any tool", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      routedFetch([["/api/projects?", { data: [], total: 0, page: 1, limit: 5 }]], calls),
    );
    mintEphemeralToken.mockImplementationOnce(async () => {
      calls.push("mint");
      return { raw: "tok_raw_fallback", id: "tok_id_fallback" };
    });

    await runAssistantFallback({
      actor: testActor(),
      message: "hello",
      origin: "http://localhost:3000",
      rateCheck: async () => {
        calls.push("rateCheck");
      },
    });

    expect(calls[0]).toBe("rateCheck");
    expect(calls.indexOf("rateCheck")).toBeLessThan(calls.indexOf("mint"));
    expect(calls.indexOf("mint")).toBeLessThan(calls.findIndex((c) => c.startsWith("fetch:")));
  });

  it("propagates a rateCheck failure WITHOUT minting a token or executing any tool", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      runAssistantFallback({
        actor: testActor(),
        message: "hello",
        origin: "http://localhost:3000",
        rateCheck: async () => {
          throw new Error("Demo key rate limit exceeded.");
        },
      }),
    ).rejects.toThrow("Demo key rate limit exceeded.");

    expect(mintEphemeralToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (c) unmatched-input default path
// ---------------------------------------------------------------------------
describe("runAssistantFallback — unmatched input default path", () => {
  it("returns a grounded, non-empty reply with a capability hint for an unmatched message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, { data: [{ id: "p1", name: "Proj One" }], total: 4, page: 1, limit: 5 }),
      ),
    );

    const result = await runAssistantFallback({
      actor: testActor(),
      message: "zzz random unmatched text 12345",
      origin: "http://localhost:3000",
      rateCheck: async () => {},
    });

    expect(result.reply).toContain("fallback mode");
    expect(result.reply.toLowerCase()).toContain("ask me");
    expect(result.reply).not.toBe("");
  });

  it("still returns grounded text (not a crash) when the safe default tool call fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "boom" })));

    const result = await runAssistantFallback({
      actor: testActor(),
      message: "zzz random unmatched text 12345",
      origin: "http://localhost:3000",
      rateCheck: async () => {},
    });

    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.usedFallback).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (d) ephemeral token lifecycle
// ---------------------------------------------------------------------------
describe("runAssistantFallback — ephemeral token lifecycle", () => {
  it("mints exactly one ephemeral token and revokes it on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { data: [], total: 0, page: 1, limit: 5 })));

    await runAssistantFallback({
      actor: testActor(),
      message: "what's the project status",
      origin: "http://localhost:3000",
      rateCheck: async () => {},
    });

    expect(mintEphemeralToken).toHaveBeenCalledTimes(1);
    expect(revokeEphemeralToken).toHaveBeenCalledTimes(1);
    expect(revokeEphemeralToken).toHaveBeenCalledWith("tok_id_fallback");
  });

  it("still revokes the token when a tool call throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const result = await runAssistantFallback({
      actor: testActor(),
      message: "what's the project status",
      origin: "http://localhost:3000",
      rateCheck: async () => {},
    });

    // callReadTool catches fetch errors internally and records ok:false —
    // the fallback itself does not throw.
    expect(result.usedFallback).toBe(true);
    expect(mintEphemeralToken).toHaveBeenCalledTimes(1);
    expect(revokeEphemeralToken).toHaveBeenCalledTimes(1);
  });
});

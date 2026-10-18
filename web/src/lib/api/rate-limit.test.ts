/**
 * Unit tests for the baseline DB-backed rate limiter (T3-rate-limiter):
 *  - allowed: resolves silently
 *  - exceeded: throws RateLimitError (429) AND attempts a fail-soft audit row
 *  - RPC error: fails OPEN (never throws), logs loudly
 *  - key composition + read/write bucket selection by HTTP method
 *  - a fail-soft audit-write failure never turns into an unhandled throw
 *    (the RateLimitError from the exceeded limit still surfaces)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { RateLimitError } from "@/lib/api/errors";

const { writeAudit } = vi.hoisted(() => ({
  writeAudit: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/audit/write", () => ({ writeAudit }));

import { checkRateLimit } from "./rate-limit";

function testActor(overrides: Partial<Actor> = {}): Actor {
  return { type: "user", id: "usr_1", label: "Test User", workspaceId: "ws_1", ...overrides };
}

function req(method = "GET"): NextRequest {
  return { method } as unknown as NextRequest;
}

function dbWith(rpcImpl: (...args: unknown[]) => Promise<unknown>) {
  const rpc = vi.fn(rpcImpl);
  return { rpc } as unknown as Parameters<typeof checkRateLimit>[0];
}

beforeEach(() => {
  writeAudit.mockClear();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("checkRateLimit — allowed", () => {
  it("resolves without throwing when allowed:true, and writes no audit row", async () => {
    const db = dbWith(async () => ({
      data: { allowed: true, remaining: 599, retry_after_seconds: 0 },
      error: null,
    }));
    await expect(checkRateLimit(db, testActor(), req())).resolves.toBeUndefined();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

/** rpc mock: counters refuse every key except the ones listed as allowed (e.g. the audit marker). */
function dbDenyingExcept(allowedPrefixes: string[], retry = 12) {
  return dbWith(async (...args: unknown[]) => {
    const key = String((args[1] as { p_key: string }).p_key);
    const ok = allowedPrefixes.some((p) => key.startsWith(p));
    return { data: { allowed: ok, remaining: 0, retry_after_seconds: ok ? 0 : retry }, error: null };
  });
}

describe("checkRateLimit — exceeded", () => {
  it("throws RateLimitError (429, code rate_limited) carrying the retry-after seconds", async () => {
    const db = dbDenyingExcept(["rate-limited-audit:"], 30);
    const err = await checkRateLimit(db, testActor(), req()).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.status).toBe(429);
    expect(err.code).toBe("rate_limited");
    expect(err.message).toMatch(/30s/);
    expect(err.retryAfterSeconds).toBe(30);
  });

  it("writes ONE fail-soft audit row (rate.limited) on the first blocked attempt in a window", async () => {
    const db = dbDenyingExcept(["rate-limited-audit:"]);
    await expect(checkRateLimit(db, testActor(), req())).rejects.toThrow(RateLimitError);
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit.mock.calls[0][0]).toMatchObject({
      workspaceId: "ws_1",
      action: "rate.limited",
      targetType: "rate_limit",
    });
  });

  it("writes NO further audit row for later refusals in the same window (A3-7)", async () => {
    // Marker already consumed: every counter, including the marker, refuses.
    const db = dbDenyingExcept([]);
    for (let i = 0; i < 5; i++) {
      await expect(checkRateLimit(db, testActor(), req())).rejects.toThrow(RateLimitError);
    }
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("still throws RateLimitError even if the fail-soft audit write itself fails", async () => {
    writeAudit.mockRejectedValueOnce(new Error("audit_log insert failed"));
    const db = dbDenyingExcept(["rate-limited-audit:"], 5);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(checkRateLimit(db, testActor(), req())).rejects.toThrow(RateLimitError);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("one runaway token's bucket does not touch another token's bucket", async () => {
    const db = dbWith(async (...args: unknown[]) => {
      const key = String((args[1] as { p_key: string }).p_key);
      const bad = key.includes(":tok_runaway:");
      return { data: { allowed: !bad, remaining: 0, retry_after_seconds: bad ? 9 : 0 }, error: null };
    });
    await expect(
      checkRateLimit(db, testActor({ type: "token", id: "tok_runaway" }), req("POST")),
    ).rejects.toThrow(RateLimitError);
    await expect(
      checkRateLimit(db, testActor({ type: "token", id: "tok_other" }), req("POST")),
    ).resolves.toBeUndefined();
  });
});

describe("checkRateLimit — RPC error (fail-open)", () => {
  it("does NOT throw when the RPC errors, and logs loudly", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = dbWith(async () => ({ data: null, error: { message: "connection reset" } }));

    await expect(checkRateLimit(db, testActor(), req())).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [msg] = errorSpy.mock.calls[0];
    expect(String(msg)).toMatch(/fail(ing)?\s+open/i);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe("checkRateLimit — key composition and read/write bucketing", () => {
  it("keys by workspaceId:actorType:actorId:read (and the workspace ceiling) for GET/HEAD/OPTIONS", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const db = dbWith(async () => ({
        data: { allowed: true, remaining: 1, retry_after_seconds: 0 },
        error: null,
      }));
      await checkRateLimit(db, testActor({ workspaceId: "ws_x", type: "token" }), req(method));
      expect(db.rpc).toHaveBeenCalledWith(
        "nopm_rate_check",
        expect.objectContaining({ p_key: "ws_x:token:read" }),
      );
    }
  });

  it("keys by workspaceId:actorType:actorId:write (and the workspace ceiling) for POST/PATCH/PUT/DELETE", async () => {
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const db = dbWith(async () => ({
        data: { allowed: true, remaining: 1, retry_after_seconds: 0 },
        error: null,
      }));
      await checkRateLimit(db, testActor({ workspaceId: "ws_y", type: "user" }), req(method));
      expect(db.rpc).toHaveBeenCalledWith(
        "nopm_rate_check",
        expect.objectContaining({ p_key: "ws_y:user:write" }),
      );
    }
  });

  it("uses the default per-actor limits (600 read / 120 write), a higher workspace ceiling, 60s window", async () => {
    const db = dbWith(async () => ({
      data: { allowed: true, remaining: 1, retry_after_seconds: 0 },
      error: null,
    }));
    await checkRateLimit(db, testActor(), req("GET"));
    expect(db.rpc).toHaveBeenCalledWith(
      "nopm_rate_check",
      expect.objectContaining({ p_max: 600, p_window_seconds: 60 }),
    );
  });
});

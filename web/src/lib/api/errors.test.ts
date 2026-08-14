/**
 * Typed-error → HTTP mapping tests.
 *
 * Invariants:
 *  - each ApiError subclass maps to its documented status (401/403/404/422)
 *  - the { error } contract holds, with `code` present only when set
 *  - an unknown throwable NEVER leaks its message or stack in production
 *    (CWE-209); in dev the message is surfaced deliberately
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiError, AuthError, ScopeError, NotFoundError, RuleError, toErrorResponse } from "./errors";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("error classes — status, message and code defaults", () => {
  it("AuthError defaults to 401 / unauthorized", () => {
    const e = new AuthError();
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(401);
    expect(e.message).toBe("Authentication required");
    expect(e.code).toBe("unauthorized");
  });

  it("ScopeError defaults to 403 / forbidden_scope", () => {
    const e = new ScopeError();
    expect(e.status).toBe(403);
    expect(e.message).toBe("Insufficient scope for this action");
    expect(e.code).toBe("forbidden_scope");
  });

  it("NotFoundError defaults to 404 / not_found", () => {
    const e = new NotFoundError();
    expect(e.status).toBe(404);
    expect(e.message).toBe("Not found");
    expect(e.code).toBe("not_found");
  });

  it("RuleError requires a message and defaults to 422 / rule_violation", () => {
    const e = new RuleError("Approver must differ from requester");
    expect(e.status).toBe(422);
    expect(e.message).toBe("Approver must differ from requester");
    expect(e.code).toBe("rule_violation");
  });

  it("subclasses accept custom messages and codes", () => {
    const e = new ScopeError("Token lacks task:delete:approve", "missing_scope");
    expect(e.message).toBe("Token lacks task:delete:approve");
    expect(e.code).toBe("missing_scope");
  });

  it('every subclass reports name "ApiError" (set in the base constructor)', () => {
    // Worth pinning: instanceof is the reliable discriminator, not `.name`.
    for (const e of [new AuthError(), new ScopeError(), new NotFoundError(), new RuleError("x")]) {
      expect(e.name).toBe("ApiError");
      expect(e).toBeInstanceOf(Error);
    }
  });
});

describe("toErrorResponse — ApiError mapping", () => {
  const cases: Array<[string, ApiError, number, string, string]> = [
    ["AuthError", new AuthError(), 401, "Authentication required", "unauthorized"],
    ["ScopeError", new ScopeError(), 403, "Insufficient scope for this action", "forbidden_scope"],
    ["NotFoundError", new NotFoundError(), 404, "Not found", "not_found"],
    ["RuleError", new RuleError("Self-approval rejected"), 422, "Self-approval rejected", "rule_violation"],
  ];

  it.each(cases)("%s → %i with { error, code }", async (_name, error, status, message, code) => {
    const res = toErrorResponse(error);
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body).toEqual({ error: message, code });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("maps a bare ApiError to its own status, with no code key when none was set", async () => {
    const res = toErrorResponse(new ApiError(409, "Project is locked"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: "Project is locked" });
    expect("code" in body).toBe(false);
  });

  it("includes the code key when the bare ApiError carries one", async () => {
    const body = await toErrorResponse(new ApiError(423, "Locked", "project_locked")).json();
    expect(body).toEqual({ error: "Locked", code: "project_locked" });
  });

  it("never logs a handled ApiError to the server console", () => {
    toErrorResponse(new NotFoundError("Task not found"));
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("toErrorResponse — unknown throwables", () => {
  it("returns a sanitized 500 in production: no message, no stack, no extra keys", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const boom = new Error("connection string postgres://user:pa55w0rd@db/nopm failed");

    const res = toErrorResponse(boom);
    expect(res.status).toBe(500);
    const body = await res.json();

    expect(body).toEqual({ error: "Internal server error" });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("pa55w0rd");
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("stack");
    expect(Object.keys(body)).toEqual(["error"]);
  });

  it("logs the unexpected error server-side (so it is observable, just not returned)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const boom = new Error("kaboom");
    toErrorResponse(boom);
    expect(console.error).toHaveBeenCalledWith("[nopm] unhandled error:", boom);
  });

  it("surfaces the message outside production (dev ergonomics)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const body = await toErrorResponse(new Error("kaboom")).json();
    expect(body).toEqual({ error: "kaboom" });
  });

  it.each([
    ["a string throwable", "just a string"],
    ["a plain object", { secret: "hunter2" }],
    ["null", null],
    ["undefined", undefined],
  ])("sanitizes %s to a generic 500 even in dev (non-Error path)", async (_label, thrown) => {
    vi.stubEnv("NODE_ENV", "development");
    const res = toErrorResponse(thrown);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Internal server error" });
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("does not leak a subclassed non-Api error's message in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    class DbError extends Error {}
    const body = await toErrorResponse(new DbError("relation audit_log does not exist")).json();
    expect(body.error).toBe("Internal server error");
  });
});

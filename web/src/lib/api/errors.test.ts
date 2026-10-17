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
import {
  ApiError,
  AuthError,
  ScopeError,
  NotFoundError,
  RuleError,
  RateLimitError,
  FieldsError,
  invalidInputError,
  toErrorResponse,
} from "./errors";

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

  it("RateLimitError defaults to 429 / rate_limited", () => {
    const e = new RateLimitError();
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(429);
    expect(e.message).toBe("Rate limit exceeded");
    expect(e.code).toBe("rate_limited");
  });

  it("subclasses accept custom messages and codes", () => {
    const e = new ScopeError("Token lacks task:delete:approve", "missing_scope");
    expect(e.message).toBe("Token lacks task:delete:approve");
    expect(e.code).toBe("missing_scope");
  });

  it('every subclass reports name "ApiError" (set in the base constructor)', () => {
    // Worth pinning: instanceof is the reliable discriminator, not `.name`.
    for (const e of [
      new AuthError(),
      new ScopeError(),
      new NotFoundError(),
      new RuleError("x"),
      new RateLimitError(),
    ]) {
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
    ["RateLimitError", new RateLimitError("Retry in 30s."), 429, "Retry in 30s.", "rate_limited"],
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

  it("FieldsError -> 422 with { error, code, fields } (the validationError shape plus a code)", async () => {
    const fields = [{ field: "owner_id", message: "owner_id was not found in this workspace" }];
    const e = new FieldsError("Referenced record not found in this workspace", fields, "invalid_reference");
    expect(e).toBeInstanceOf(ApiError);
    const res = toErrorResponse(e);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "Referenced record not found in this workspace",
      code: "invalid_reference",
      fields,
    });
    expect(console.error).not.toHaveBeenCalled();
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

describe("invalidInputError — malformed ids and values are the caller's, not a 500 (V1 R1-Low)", () => {
  const uuidMsg = (v: string) => `invalid input syntax for type uuid: "${v}"`;

  it("a PostgREST error object (SQLSTATE 22P02) for a PATH param -> 404 not_found, without echoing the value", () => {
    const err = invalidInputError({ code: "22P02", message: uuidMsg("not-a-uuid") }, ["not-a-uuid"]);
    expect(err).toBeInstanceOf(NotFoundError);
    expect([err?.status, err?.code, err?.message]).toEqual([404, "not_found", "Not found"]);
  });

  it("routes that re-wrap the error as new Error(message) lose the code: the message is matched too", () => {
    const err = invalidInputError(new Error(uuidMsg("123")), ["123"]);
    expect([err?.status, err?.code]).toEqual([404, "not_found"]);
  });

  it("an empty / NUL path value (Postgres quotes it as \"\") is still a path id", () => {
    expect(invalidInputError(new Error(uuidMsg("")), [String.fromCharCode(0)])?.status).toBe(404);
  });

  it("a value that is NOT a path param (query filter, body field) -> 422 validation_failed", () => {
    for (const pathValues of [[], ["11111111-1111-4111-8111-111111111111"]]) {
      const err = invalidInputError({ code: "22P02", message: uuidMsg("not-a-uuid") }, pathValues);
      expect([err?.status, err?.code]).toEqual([422, "validation_failed"]);
      expect(err?.message).not.toContain("not-a-uuid");
    }
  });

  it("bad enum / number values are 22P02 too -> 422", () => {
    expect(invalidInputError({ code: "22P02", message: 'invalid input value for enum task_status: "zzz"' })?.status).toBe(422);
    expect(invalidInputError(new Error('invalid input syntax for type integer: "abc"'))?.status).toBe(422);
    expect(invalidInputError({ code: "22P02" })?.status).toBe(422);
  });

  it("everything else is left to the normal mapping", () => {
    expect(invalidInputError(new Error("connection refused"))).toBeNull();
    expect(invalidInputError({ code: "23505", message: "duplicate key value" })).toBeNull();
    expect(invalidInputError({ code: "P0010", message: "PROJECT_LOCKED" })).toBeNull();
    expect(invalidInputError("22P02")).toBeNull();
    expect(invalidInputError(null)).toBeNull();
    // already a typed error: untouched
    expect(invalidInputError(new RuleError("invalid input syntax for type uuid"))).toBeNull();
  });
});

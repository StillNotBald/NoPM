import { NextResponse } from "next/server";

/**
 * Typed API errors. Thrown anywhere in a handler and converted to the
 * { error } contract by `toErrorResponse`. Production messages are
 * sanitized (no internal leakage, guards CWE-209); 4xx messages are
 * client-safe and shown verbatim.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class AuthError extends ApiError {
  constructor(message = "Authentication required", code = "unauthorized") {
    super(401, message, code);
  }
}

export class ScopeError extends ApiError {
  constructor(message = "Insufficient scope for this action", code = "forbidden_scope") {
    super(403, message, code);
  }
}

export class NotFoundError extends ApiError {
  constructor(message = "Not found", code = "not_found") {
    super(404, message, code);
  }
}

/** Business-rule / state-transition failure (e.g. self-approval rejected). */
export class RuleError extends ApiError {
  constructor(message: string, code = "rule_violation") {
    super(422, message, code);
  }
}

/**
 * Field-level validation failure that is discovered AFTER zod parsing, in the
 * handler (e.g. a referenced id that is not in the caller's workspace). Same
 * 422 + `{ error, fields }` body the zod path produces through
 * `validationError`, so a client handles both with one code path; thrown (not
 * returned) so a shared helper can raise it from anywhere in a handler.
 */
export class FieldsError extends ApiError {
  constructor(
    message: string,
    public readonly fields: { field: string; message: string }[],
    code = "validation_failed",
  ) {
    super(422, message, code);
  }
}

/**
 * Optimistic concurrency conflict (R-90): the caller sent
 * `expected_updated_at` on a PATCH and the row's current `updated_at` no
 * longer matches — someone else wrote it first. `currentUpdatedAt`, when
 * known, is echoed back on the response body as `current_updated_at` so the
 * caller can show/refresh the latest value and retry deliberately instead of
 * blindly overwriting it.
 */
export class PreconditionFailedError extends ApiError {
  constructor(
    message = "Record changed since you loaded it",
    public readonly currentUpdatedAt?: string,
    code = "precondition_failed",
  ) {
    super(412, message, code);
  }
}

/** Workspace+actor-class request budget exceeded (see @/lib/api/rate-limit). */
export class RateLimitError extends ApiError {
  constructor(message = "Rate limit exceeded", code = "rate_limited") {
    super(429, message, code);
  }
}

/**
 * Postgres `invalid_text_representation` (SQLSTATE 22P02) reaches us as the
 * caller's own malformed input: a non-UUID id in a path or filter
 * (`invalid input syntax for type uuid: "123"`), a bad enum value, a bad number.
 * It used to fall through to a sanitized 500. Routes often re-wrap the
 * PostgREST error as `new Error(error.message)`, which drops the code, so the
 * message is matched as well.
 *
 *  - the offending value is one of the route's PATH params (or an empty/NUL
 *    value, which Postgres quotes as "") -> 404 `not_found`: no such record;
 *  - anywhere else (a query filter, a body field) -> 422 `validation_failed`.
 *
 * Neither echoes the value back. Returns null for anything else, so the normal
 * error mapping applies.
 */
const INVALID_INPUT = /invalid input (syntax for type|value for enum)/i;

export function invalidInputError(error: unknown, pathValues: readonly string[] = []): ApiError | null {
  if (error instanceof ApiError || typeof error !== "object" || error === null) return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  const text = typeof message === "string" ? message : "";
  if (code !== "22P02" && !INVALID_INPUT.test(text)) return null;

  const quoted = text.match(/: "([\s\S]*)"/)?.[1];
  const inPath = quoted !== undefined && pathValues.length > 0 && (quoted === "" || pathValues.includes(quoted));
  return inPath
    ? new NotFoundError("Not found")
    : new ApiError(422, "Invalid id or value format in the request", "validation_failed");
}

export function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof PreconditionFailedError) {
    return NextResponse.json(
      {
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.currentUpdatedAt ? { current_updated_at: error.currentUpdatedAt } : {}),
      },
      { status: error.status },
    );
  }
  if (error instanceof FieldsError) {
    return NextResponse.json(
      { error: error.message, ...(error.code ? { code: error.code } : {}), fields: error.fields },
      { status: error.status },
    );
  }
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: error.message, ...(error.code ? { code: error.code } : {}) },
      { status: error.status },
    );
  }
  // Unexpected: log server-side, return a sanitized 500.
  console.error("[nopm] unhandled error:", error);
  const dev = process.env.NODE_ENV !== "production";
  return NextResponse.json(
    { error: dev && error instanceof Error ? error.message : "Internal server error" },
    { status: 500 },
  );
}

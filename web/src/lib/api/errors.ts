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

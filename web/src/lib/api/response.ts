import { NextResponse } from "next/server";

/**
 * The single JSON contract for every NoPM endpoint:
 *   success → { data: ... }   (+ { total, page, limit } for lists)
 *   failure → { error: string } (+ { fields } for validation)
 * Stable shapes so any CLI agent can parse reliably.
 */
export type FieldError = { field: string; message: string };

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ data }, init);
}

export function okList<T>(
  items: T[],
  meta: { total: number; page: number; limit: number },
) {
  return NextResponse.json({ data: items, ...meta });
}

export function created<T>(data: T) {
  return NextResponse.json({ data }, { status: 201 });
}

export function noContent() {
  return new NextResponse(null, { status: 204 });
}

export function fail(message: string, status = 500, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export function validationError(message: string, fields?: FieldError[]) {
  return NextResponse.json(
    { error: message, ...(fields ? { fields } : {}) },
    { status: 422 },
  );
}

/** Parse a JSON body without ever throwing (bad input → null, never a 500). */
export async function safeJson<T = unknown>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

import { validationError } from "@/lib/api/response";

/**
 * Q-WRK-18 — "fields accepted but not saved". zod strips keys a schema does not
 * know, so a caller (or an agent) that sends `{ colour: "red" }` got a 200 and
 * nothing happened. The common pattern (Jira REST) is to refuse: the response is
 * a 422 naming each unknown field and nothing is written.
 *
 * Call it with the raw JSON body and the route's zod object schema BEFORE
 * safeParse; return the result when it is non-null.
 */
export function unknownFieldsMessage(names: string[]): string {
  return names.length === 1
    ? `Unknown field "${names[0]}". Nothing was saved.`
    : `Unknown fields ${names.map((n) => `"${n}"`).join(", ")}. Nothing was saved.`;
}

export function findUnknownFields(
  body: unknown,
  schema: { shape: Record<string, unknown> },
  allow: readonly string[] = [],
): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const known = new Set<string>([...Object.keys(schema.shape), ...allow]);
  return Object.keys(body as Record<string, unknown>).filter((k) => !known.has(k));
}

export function unknownFieldsResponse(
  body: unknown,
  schema: { shape: Record<string, unknown> },
  allow: readonly string[] = [],
) {
  const unknown = findUnknownFields(body, schema, allow);
  if (unknown.length === 0) return null;
  return validationError(
    unknownFieldsMessage(unknown),
    unknown.map((field) => ({ field, message: unknownFieldsMessage([field]) })),
  );
}

/**
 * Audit provenance resolution (R-82, migration 20260906000042_audit_channel.sql).
 *
 * Every audit_log row records which CLIENT declared the write and a
 * per-request correlation id — provable provenance, not label-inferred from
 * actor_type alone. Pure function so it's cheaply unit-testable: no request
 * object side effects, just Headers in, a resolved { channel, requestId }
 * out.
 *
 * `channel` is CALLER-ASSERTED via the `X-NoPM-Client` header — it is NOT an
 * authorization input. Token identity (scopes, workspace_id) stays the
 * authoritative actor; channel is provenance metadata only, so a caller
 * lying about its channel gains nothing beyond a mislabeled audit row.
 */

export type AuditChannel = "ui" | "api" | "cli" | "mcp" | "assistant" | "lark";

/**
 * Channels a caller may DECLARE via X-NoPM-Client. Connector channels
 * ("lark") are deliberately absent: they are server-derived from a verified
 * connector binding (src/lib/integrations), never from a header, so the
 * provenance of a chat-originated approval cannot be spoofed.
 */
const VALID_CHANNELS: ReadonlySet<string> = new Set<AuditChannel>([
  "ui",
  "api",
  "cli",
  "mcp",
  "assistant",
]);

/** X-Request-Id must be a short, safe token — never trust it to be a UUID. */
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Resolve the declared channel + a correlation request id from incoming
 * request headers.
 *
 * channel: `X-NoPM-Client` if it names one of the five known channels, else
 * a default per actor type — 'ui' for session (human) actors, 'api' for
 * token (Bearer PAT) actors, matching how each surface behaves when it
 * sends no header at all (a bare `curl`/Bearer caller is presumed generic
 * API use; a signed-in browser session is presumed UI use).
 *
 * requestId: the incoming `X-Request-Id` when it matches the safe-token
 * shape, else a freshly generated UUID — so every row can always be tied
 * back to exactly one request, whether or not the caller supplied one.
 */
export function resolveClientMeta(
  headers: Headers,
  actorType: "user" | "token",
): { channel: AuditChannel; requestId: string } {
  const declared = headers.get("x-nopm-client");
  const channel: AuditChannel =
    declared && VALID_CHANNELS.has(declared)
      ? (declared as AuditChannel)
      : actorType === "token"
        ? "api"
        : "ui";

  return { channel, requestId: resolveRequestId(headers) };
}

/**
 * The incoming `X-Request-Id` when it matches the safe-token shape, else a
 * freshly generated UUID. Shared by route() (via resolveClientMeta) and the
 * MCP Streamable-HTTP endpoint, which authenticates outside route() but must
 * still hand every internal tool call one correlation id and echo it back.
 */
export function resolveRequestId(headers: Headers): string {
  const incoming = headers.get("x-request-id");
  return incoming && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
}

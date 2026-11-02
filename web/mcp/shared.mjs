/**
 * Shared MCP plumbing for BOTH servers: the stdio server (web/mcp/server.mjs)
 * and the remote route (web/src/app/api/mcp/route.ts). Plain Node, no build
 * step, no dependencies, so the two cannot drift apart (audit M2, M4, M5, M6).
 *
 *   toMcpTool(tool)            tools/list entry with title + annotations
 *   callApi({...})             one fetch with a timeout; never throws
 *   toToolResult(res)          MCP tool result: compact JSON, isError mapping,
 *                              size cap and next_page hint
 *   filterToolsByOpenApi(...)  keep only tools whose route the server serves
 */

/** Per-call timeout for the REST hop. A hung API must not hold a serverless function. */
export const API_TIMEOUT_MS = 25_000;

/** A tool result above this many characters is cut, with a hint to narrow the query. */
export const MAX_RESULT_CHARS = 60_000;

/** Prefix of the non-JSON body kept in an error result. */
const NON_JSON_PREVIEW_CHARS = 300;

/**
 * Tools that change real state in a way a reviewer would want flagged:
 * a decision that goes live or closes something. Everything else that writes
 * only creates or edits one record (or raises/cancels a deletion REQUEST, which
 * a different person still has to approve), so it is not marked destructive.
 */
export const DESTRUCTIVE_TOOLS = new Set([
  "apply_rebaseline",
  "sign_off_rebaseline",
  "implement_change_request",
  "close_sprint",
]);

/** request_*_deletion and withdraw_deletion_request only raise or cancel a REQUEST (maker-checker): nothing is deleted. */
function isDeletionRequestTool(name) {
  return name.startsWith("request_") || name === "withdraw_deletion_request";
}

/** "create_task" -> "Create task". */
function titleOf(name) {
  const words = String(name).split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * MCP tool annotations, derived from the HTTP method the tool's own route uses
 * (the same `toRequest({})` probe the registry guard uses).
 *  - GET: read-only.
 *  - POST/PATCH/PUT: a write; PATCH/PUT are idempotent; not destructive unless
 *    listed in DESTRUCTIVE_TOOLS.
 *  - DELETE: destructive, except the deletion-REQUEST tools (they only raise or cancel a request).
 * openWorldHint is false everywhere: every tool talks only to this NoPM workspace.
 */
export function toolAnnotations(tool) {
  const method = String(tool.toRequest({}).method).toUpperCase();
  const title = titleOf(tool.name);
  if (method === "GET") {
    return { title, readOnlyHint: true, openWorldHint: false };
  }
  return {
    title,
    readOnlyHint: false,
    destructiveHint: DESTRUCTIVE_TOOLS.has(tool.name) || (method === "DELETE" && !isDeletionRequestTool(tool.name)),
    idempotentHint: method === "PATCH" || method === "PUT",
    openWorldHint: false,
  };
}

/** The tools/list entry for one registry tool. */
export function toMcpTool(tool) {
  const annotations = toolAnnotations(tool);
  return {
    name: tool.name,
    title: annotations.title,
    description: tool.description,
    inputSchema: tool.parameters,
    annotations,
  };
}

/**
 * Call the NoPM REST API. NEVER throws: a network error or a timeout comes back
 * as `{ ok:false, status:0, body:{error} }`, so the caller can turn it into an
 * MCP `isError` result instead of an opaque JSON-RPC internal error.
 *
 * @param {{ baseUrl: string, token: string, path: string, method: string, body?: unknown,
 *   requestId?: string, client?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} opts
 */
export async function callApi({
  baseUrl,
  token,
  path,
  method,
  body,
  requestId,
  client = "mcp",
  timeoutMs = API_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-NoPM-Client": client,
  };
  // Forward the caller's correlation id so the audit row links back (R-82).
  if (requestId) headers["X-Request-Id"] = requestId;
  try {
    const res = await fetchImpl(String(baseUrl).replace(/\/$/, "") + path, {
      method,
      headers,
      body: body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const retryAfter = Number.parseInt(res.headers?.get?.("retry-after") ?? "", 10);
    return {
      ok: res.ok,
      status: res.status,
      body:
        parsed !== null && typeof parsed === "object"
          ? parsed
          : { error: `Non-JSON response (HTTP ${res.status})`, raw: text.slice(0, NON_JSON_PREVIEW_CHARS) },
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
    };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      ok: false,
      status: 0,
      // Fixed text: never the raw error, which can carry the internal origin.
      body: { error: timedOut ? "NoPM API timed out" : "Network error calling the NoPM API" },
    };
  }
}

/**
 * Turn an API reply into an MCP tool result.
 *  - success: compact JSON (no pretty-print), `next_page` when more pages exist,
 *    cut at MAX_RESULT_CHARS with a hint;
 *  - failure (non-2xx or an `error` string): `{ error, status, code?,
 *    retry_after_seconds?, fields? }` with `isError: true`.
 */
export function toToolResult(res) {
  const body = res.body ?? {};
  const failed = !res.ok || typeof body.error === "string";
  if (failed) {
    const out = { error: typeof body.error === "string" ? body.error : `HTTP ${res.status}`, status: res.status };
    if (typeof body.code === "string") out.code = body.code;
    if (res.retryAfterSeconds !== undefined) out.retry_after_seconds = res.retryAfterSeconds;
    if (body.fields !== undefined) out.fields = body.fields;
    if (typeof body.raw === "string") out.raw = body.raw;
    return { content: [{ type: "text", text: JSON.stringify(out) }], isError: true };
  }
  let result = body;
  const { total, page, limit } = body;
  if (Number.isFinite(total) && Number.isFinite(page) && Number.isFinite(limit) && page * limit < total) {
    result = { ...body, next_page: page + 1 };
  }
  let text = JSON.stringify(result);
  if (text.length > MAX_RESULT_CHARS) {
    text =
      text.slice(0, MAX_RESULT_CHARS) +
      `\n[truncated at ${MAX_RESULT_CHARS} characters: use fields= or a lower limit, or fetch the next page]`;
  }
  return { content: [{ type: "text", text }], isError: false };
}

/** A tool-call result for a refused call (unknown tool, bad arguments). */
export function errorResult(message) {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

const UUID_SEG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Does the OpenAPI `paths` object serve this concrete route (ids matched to `{param}` segments)? */
function servesPath(openApiPaths, path) {
  const cut = path.indexOf("?");
  const segs = (cut === -1 ? path : path.slice(0, cut)).split("/");
  return Object.keys(openApiPaths).some((tpl) => {
    const t = tpl.split("/");
    return (
      t.length === segs.length &&
      t.every((seg, i) => seg === segs[i] || (/^\{.+\}$/.test(seg) && UUID_SEG.test(segs[i])))
    );
  });
}

/**
 * Stdio parity with the remote route (audit M4). The remote route filters with
 * NOPM_MODULES through lib/modules.ts, which a plain-Node file cannot import.
 * The server's own /api/openapi.json is already filtered the same way, so keep
 * only tools whose route that spec still serves. If the spec cannot be read,
 * keep every tool (fail open: a listing is never worse than before).
 */
export async function filterToolsByOpenApi(tools, { baseUrl, fetchImpl = fetch, warn = () => {} }) {
  try {
    const res = await fetchImpl(String(baseUrl).replace(/\/$/, "") + "/api/openapi.json", {
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const spec = await res.json();
    if (!spec || typeof spec.paths !== "object" || spec.paths === null) throw new Error("no paths");
    return tools.filter((t) => servesPath(spec.paths, t.toRequest({}).path));
  } catch (err) {
    warn(`could not read /api/openapi.json (${err instanceof Error ? err.message : "error"}); listing every tool`);
    return tools;
  }
}

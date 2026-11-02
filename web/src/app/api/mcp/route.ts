import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AuthError, toErrorResponse } from "@/lib/api/errors";
import { resolveRequestId } from "@/lib/audit/channel";
import { resolveInternalOrigin } from "@/lib/api/internal-origin";
import { filterTools } from "@/lib/modules";
// mcp/tools.mjs MCP_TOOLS = assistant registry + MCP-only governance tools (as the stdio server)
// (web/mcp/server.mjs) and the in-app BYOK assistant — kept outside src/ on
// purpose so it stays a plain-Node, no-build-step artifact for the CLI.
import { MCP_TOOLS } from "../../../../mcp/tools.mjs";
import { callApi, errorResult, toMcpTool, toToolResult } from "../../../../mcp/shared.mjs";

export const runtime = "nodejs";

/**
 * GET/POST/DELETE /api/mcp — remote Streamable HTTP MCP transport.
 *
 * Same governance posture as the stdio server (ADR 0007): this route holds
 * no privileged credentials of its own. The caller's own scoped `npm_` PAT
 * is read from the Authorization header on every request and forwarded
 * verbatim to this same origin's REST API — scopes, audit, and
 * maker-checker are all enforced there, unchanged. A missing/invalid token
 * surfaces as a normal { error } tool result (or a 401 if no header was
 * sent at all), never bypassed.
 *
 * Stateless mode (no sessionIdGenerator): a fresh Server + transport per
 * request, matching Vercel's serverless execution model — nothing is held
 * in memory across invocations.
 */

type ToolRegistryEntry = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  toRequest: (args: Record<string, unknown>) => { path: string; method: string; body?: unknown };
};

// Tools of modules switched off with NOPM_MODULES (ADR 0019) are neither listed nor callable.
const REGISTRY = filterTools(MCP_TOOLS as ToolRegistryEntry[]);

function buildServer(origin: string, token: string, requestId: string | null): Server {
  const server = new Server({ name: "nopm", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: REGISTRY.map(toMcpTool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    const tool = REGISTRY.find((t) => t.name === name);
    if (!tool) return errorResult(`Unknown tool: ${name}`);

    let req: { path: string; method: string; body?: unknown };
    try {
      req = tool.toRequest(args);
    } catch (err) {
      return errorResult(`Bad arguments: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Forward the caller's own X-Request-Id so the eventual audit_log row
    // correlates back to this MCP request (R-82).
    return toToolResult(
      await callApi({
        baseUrl: origin,
        token,
        path: req.path,
        method: req.method,
        body: req.body,
        requestId: requestId ?? undefined,
      }),
    );
  });

  return server;
}

/**
 * M7: a wrong or revoked token must fail at connect, not on the first tool
 * call. On `initialize` and `tools/list` make ONE GET /api/me with the token;
 * a 401 is answered with the standard 401. Any other outcome (including a
 * network failure) lets the request through: only a definite 401 blocks.
 */
async function connectTokenRejected(request: Request, origin: string, token: string): Promise<boolean> {
  if (request.method !== "POST") return false;
  let methods: unknown[] = [];
  try {
    const parsed = await request.clone().json();
    methods = (Array.isArray(parsed) ? parsed : [parsed]).map((m) => (m as { method?: unknown } | null)?.method);
  } catch {
    return false;
  }
  if (!methods.some((m) => m === "initialize" || m === "tools/list")) return false;
  const me = await callApi({ baseUrl: origin, token, path: "/api/me", method: "GET" });
  return me.status === 401;
}

async function handle(request: Request): Promise<Response> {
  const authz = request.headers.get("authorization");
  if (!authz?.toLowerCase().startsWith("bearer ")) {
    // Same { error, code } 401 as every REST route (L-07), plus the challenge a
    // client needs to learn the scheme; and the correlation id route() stamps
    // on its own 401s.
    const unauthorized = toErrorResponse(
      new AuthError(
        "Missing Bearer token. Create a scoped npm_ PAT in NoPM → Settings → API Tokens and connect with Authorization: Bearer <token>.",
      ),
    );
    unauthorized.headers.set("WWW-Authenticate", 'Bearer realm="nopm"');
    unauthorized.headers.set("X-Request-Id", resolveRequestId(request.headers));
    return unauthorized;
  }
  const token = authz.slice(7).trim();
  // Never the Host header on its own: the caller's PAT is forwarded to this
  // origin, so it comes from the configured app URL (see resolveInternalOrigin).
  const origin = resolveInternalOrigin(request);
  if (!origin) {
    console.error(
      "[nopm][mcp] NEXT_PUBLIC_APP_URL is not set in production, so /api/mcp refuses rather than forwarding tokens to a Host-derived origin",
    );
    return Response.json(
      {
        error: "MCP endpoint is not configured: the operator must set NEXT_PUBLIC_APP_URL to this app's public URL.",
        code: "misconfigured",
      },
      { status: 503, headers: { "X-Request-Id": resolveRequestId(request.headers) } },
    );
  }
  // R-82: one correlation id per MCP request — the caller's X-Request-Id when
  // it is a safe token, else generated here — forwarded to every internal
  // tool-call fetch and echoed on the response, exactly like route() does.
  const requestId = resolveRequestId(request.headers);

  if (await connectTokenRejected(request, origin, token)) {
    const rejected = toErrorResponse(
      new AuthError("This token was rejected. Create a new scoped npm_ PAT in NoPM → Settings → API Tokens."),
    );
    rejected.headers.set("WWW-Authenticate", 'Bearer realm="nopm", error="invalid_token"');
    rejected.headers.set("X-Request-Id", requestId);
    return rejected;
  }

  const server = buildServer(origin, token, requestId);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  try {
    response.headers.set("X-Request-Id", requestId);
  } catch {
    // Immutable headers on some streamed responses — not fatal.
  }
  return response;
}

export { handle as GET, handle as POST, handle as DELETE };

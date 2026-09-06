import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolveRequestId } from "@/lib/audit/channel";
// mcp/tools.mjs is the single tool registry shared with the stdio server
// (web/mcp/server.mjs) and the in-app BYOK assistant — kept outside src/ on
// purpose so it stays a plain-Node, no-build-step artifact for the CLI.
import { TOOL_REGISTRY } from "../../../../mcp/tools.mjs";

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

const REGISTRY = TOOL_REGISTRY as ToolRegistryEntry[];

async function callApi(
  origin: string,
  token: string,
  path: string,
  method: string,
  body: unknown,
  requestId: string | null,
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-NoPM-Client": "mcp",
  };
  // Forward the caller's own X-Request-Id (if present) so the eventual
  // audit_log row correlates back to this MCP request rather than getting
  // a freshly generated id at the internal REST hop (R-82).
  if (requestId) headers["X-Request-Id"] = requestId;

  const res = await fetch(new URL(path, origin), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  try {
    return await res.json();
  } catch {
    return { error: `Non-JSON response (HTTP ${res.status})` };
  }
}

function buildServer(origin: string, token: string, requestId: string | null): Server {
  const server = new Server({ name: "nopm", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: REGISTRY.map(({ name, description, parameters }) => ({
      name,
      description,
      inputSchema: parameters,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    const tool = REGISTRY.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true,
      };
    }

    let req: { path: string; method: string; body?: unknown };
    try {
      req = tool.toRequest(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Bad arguments: ${message}` }) }],
        isError: true,
      };
    }

    const result = await callApi(origin, token, req.path, req.method, req.body, requestId);
    const isError = typeof (result as { error?: unknown }).error === "string";
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError,
    };
  });

  return server;
}

async function handle(request: Request): Promise<Response> {
  const authz = request.headers.get("authorization");
  if (!authz?.toLowerCase().startsWith("bearer ")) {
    return new Response(
      JSON.stringify({
        error:
          "Missing Bearer token. Create a scoped npm_ PAT in NoPM → Settings → API Tokens and connect with Authorization: Bearer <token>.",
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
  const token = authz.slice(7).trim();
  const origin = new URL(request.url).origin;
  // R-82: one correlation id per MCP request — the caller's X-Request-Id when
  // it is a safe token, else generated here — forwarded to every internal
  // tool-call fetch and echoed on the response, exactly like route() does.
  const requestId = resolveRequestId(request.headers);

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

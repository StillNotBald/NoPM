#!/usr/bin/env node
/**
 * NoPM MCP server — STDIO transport.
 * Maps MCP tool calls to NoPM REST API calls authenticated with a scoped PAT.
 *
 * Tool definitions come from ./tools.mjs — the registry the in-app assistant
 * uses (so the two agent surfaces cannot drift apart) plus the governance tools
 * only MCP offers (change request, rebaseline propose / sign-off / apply,
 * decision, document). The assistant never gets the approve tools.
 *
 * Config (env):
 *   NOPM_API_URL   Base URL of the NoPM API  (default: https://stillnotbald.com)
 *   NOPM_TOKEN     A scoped npm_ Bearer PAT   (required)
 *
 * Start:  node mcp/server.mjs
 * Or:     npm run mcp
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MCP_TOOLS } from "./tools.mjs";
import { callApi, errorResult, filterToolsByOpenApi, toMcpTool, toToolResult } from "./shared.mjs";

// ── Config ──────────────────────────────────────────────────────────────────

const API_URL = (process.env.NOPM_API_URL || "https://stillnotbald.com").replace(/\/$/, "");
const TOKEN = process.env.NOPM_TOKEN;

if (!TOKEN) {
  process.stderr.write(
    "[nopm-mcp] FATAL: NOPM_TOKEN env var is not set. " +
      "Create a scoped npm_ PAT in NoPM → Settings → API Tokens and set NOPM_TOKEN.\n",
  );
  process.exit(1);
}

// ── Tool list (module-filtered, parity with the remote route) ────────────────

const warn = (msg) => process.stderr.write(`[nopm-mcp] warning: ${msg}
`);
const TOOLS = await filterToolsByOpenApi(MCP_TOOLS, { baseUrl: API_URL, warn });

// Check the token once at startup so a wrong or revoked token is reported now,
// not on the first tool call. A network failure only warns.
{
  const me = await callApi({ baseUrl: API_URL, token: TOKEN, path: "/api/me", method: "GET" });
  if (me.status === 401) warn("NOPM_TOKEN was rejected (HTTP 401): create a new token in Settings > API Tokens.");
  else if (me.status === 0) warn(`could not reach ${API_URL} (NOPM_API_URL); tool calls will fail until it is reachable.`);
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "nopm", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// tools/list
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(toMcpTool),
}));

// tools/call
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return errorResult(`Unknown tool: ${name}`);

  let req;
  try {
    req = tool.toRequest(args);
  } catch (err) {
    return errorResult(`Bad arguments: ${err.message}`);
  }

  // Failures (403 scope, 422 maker-checker, 429, timeouts) come back as a
  // visible isError result, never a thrown exception.
  return toToolResult(
    await callApi({ baseUrl: API_URL, token: TOKEN, path: req.path, method: req.method, body: req.body }),
  );
});

// ── Main ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[nopm-mcp] server ready — ${TOOLS.length} tools, API: ${API_URL}\n`);

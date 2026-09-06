#!/usr/bin/env node
/**
 * NoPM MCP server — STDIO transport.
 * Maps MCP tool calls to NoPM REST API calls authenticated with a scoped PAT.
 *
 * Tool definitions come from ./tools.mjs — the same registry the in-app
 * assistant uses, so the two agent surfaces cannot drift apart.
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
import { TOOL_REGISTRY } from "./tools.mjs";

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

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function callApi(path, method, body) {
  const url = API_URL + path;
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    "X-NoPM-Client": "mcp",
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = { error: `Non-JSON response (HTTP ${res.status})` };
  }
  // Return the full envelope so { error } (incl. 403 scope errors) is visible.
  return json;
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "nopm", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// tools/list
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_REGISTRY.map(({ name, description, parameters }) => ({
    name,
    description,
    inputSchema: parameters,
  })),
}));

// tools/call
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  const tool = TOOL_REGISTRY.find((t) => t.name === name);
  if (!tool) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true,
    };
  }

  let req;
  try {
    req = tool.toRequest(args);
  } catch (err) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Bad arguments: ${err.message}` }) }],
      isError: true,
    };
  }

  const result = await callApi(req.path, req.method, req.body);

  // Surface { error } as a visible tool result (not a thrown exception) so the
  // MCP client can see governance failures (403 scope, 422 maker-checker, etc.)
  // rather than receiving an opaque transport error.
  const isError = typeof result.error === "string";
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    isError,
  };
});

// ── Main ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[nopm-mcp] server ready — ${TOOL_REGISTRY.length} tools, API: ${API_URL}\n`);

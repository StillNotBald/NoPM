#!/usr/bin/env node
/**
 * Smoke-test the NoPM remote HTTP MCP endpoint (/api/mcp, Streamable HTTP).
 *
 * Reads credentials from web/.env.local (NOPM_TOKEN or NOPM_MAKER_TOKEN) and
 * targets NOPM_HTTP_MCP_URL (default http://localhost:3000/api/mcp), then:
 *   1. connects (initialize handshake, done by the SDK client)
 *   2. tools/list
 *   3. tools/call list_projects
 *
 * Usage (from web/, with the dev server running):
 *   node scripts/mcp-http-smoke.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadEnv } from "./lib/env.mjs";

const env = loadEnv();
const token = env.NOPM_TOKEN || env.NOPM_MAKER_TOKEN;
const mcpUrl = env.NOPM_HTTP_MCP_URL || "http://localhost:3000/api/mcp";

if (!token) {
  console.error("smoke: no token — set NOPM_TOKEN or NOPM_MAKER_TOKEN in web/.env.local");
  process.exit(1);
}

async function run() {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "nopm-http-smoke", version: "0.0.1" }, { capabilities: {} });

  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`\ntool count: ${tools.length}`);
  console.log("tools:", tools.map((t) => t.name).join(", "));

  const callResult = await client.callTool({ name: "list_projects", arguments: { limit: 5 } });
  const content = callResult.content?.[0]?.text ?? "{}";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = {};
  }

  if (parsed.error) {
    console.log(`\nlist_projects error: ${parsed.error}`);
  } else {
    const projects = Array.isArray(parsed.data) ? parsed.data : [];
    const total = parsed.total ?? projects.length;
    console.log(`\nlist_projects: ${projects.length} returned (total=${total})`);
  }

  // Unauthenticated check: bare POST with no Authorization header must 401.
  const bareRes = await fetch(mcpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  console.log(`\nunauthenticated request status: ${bareRes.status} (expect 401)`);

  await client.close();
}

run().catch((err) => {
  console.error("smoke failed:", err.message);
  process.exitCode = 1;
});

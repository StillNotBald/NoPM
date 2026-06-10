#!/usr/bin/env node
/**
 * Smoke-test the NoPM MCP server via JSON-RPC over stdio.
 *
 * Reads credentials from web/.env.local (NOPM_TOKEN or NOPM_MAKER_TOKEN,
 * and NEXT_PUBLIC_APP_URL), spawns `node mcp/server.mjs`, sends:
 *   1. initialize
 *   2. initialized  (notification)
 *   3. tools/list
 *   4. tools/call list_projects
 *
 * Prints tool count + names and how many projects were returned, then exits.
 *
 * Usage (from web/):
 *   node scripts/mcp-smoke.mjs
 */

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");

// ── Load .env.local ───────────────────────────────────────────────────────────

function loadEnvLocal() {
  const envPath = path.join(ROOT, ".env.local");
  if (!existsSync(envPath)) return {};
  const env = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    env[key] = val;
  }
  return env;
}

const envLocal = loadEnvLocal();
const token = envLocal.NOPM_TOKEN || envLocal.NOPM_MAKER_TOKEN;
const apiUrl = envLocal.NEXT_PUBLIC_APP_URL || "https://stillnotbald.com";

if (!token) {
  console.error("smoke: no token — set NOPM_TOKEN or NOPM_MAKER_TOKEN in web/.env.local");
  process.exit(1);
}

// ── Spawn server ──────────────────────────────────────────────────────────────

const serverPath = path.join(ROOT, "mcp", "server.mjs");

const child = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    NOPM_TOKEN: token,
    NOPM_API_URL: apiUrl,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderrBuf = "";
child.stderr.on("data", (d) => { stderrBuf += d.toString(); });

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

let msgId = 1;
const pending = new Map(); // id → { resolve, reject }

let lineBuf = "";
child.stdout.on("data", (chunk) => {
  lineBuf += chunk.toString();
  let nl;
  while ((nl = lineBuf.indexOf("\n")) !== -1) {
    const line = lineBuf.slice(0, nl).trim();
    lineBuf = lineBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
    // Timeout after 15 s
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }
    }, 15_000);
  });
}

// ── Run smoke ─────────────────────────────────────────────────────────────────

async function run() {
  // 1. initialize
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "nopm-smoke", version: "0.0.1" },
  });

  // 2. initialized notification (no response expected)
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  // 3. tools/list
  const listResult = await request("tools/list");
  const tools = listResult.tools ?? [];
  console.log(`\ntool count: ${tools.length}`);
  console.log("tools:", tools.map((t) => t.name).join(", "));

  // 4. tools/call list_projects
  const callResult = await request("tools/call", {
    name: "list_projects",
    arguments: { limit: 5 },
  });
  const content = callResult.content?.[0]?.text ?? "{}";
  let parsed;
  try { parsed = JSON.parse(content); } catch { parsed = {}; }

  if (parsed.error) {
    console.log(`\nlist_projects error: ${parsed.error}`);
  } else {
    const projects = Array.isArray(parsed.data) ? parsed.data : [];
    const total = parsed.total ?? projects.length;
    console.log(`\nlist_projects: ${projects.length} returned (total=${total})`);
  }
}

run()
  .catch((err) => {
    console.error("smoke failed:", err.message);
    if (stderrBuf) console.error("server stderr:", stderrBuf.trim());
    process.exitCode = 1;
  })
  .finally(() => {
    child.stdin.end();
    child.kill();
  });

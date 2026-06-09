// cli/lib/api.mjs — shared helpers for all nopm commands
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CFG_DIR = path.join(homedir(), ".nopm");
const CFG_FILE = path.join(CFG_DIR, "config.json");

export function loadConfig() {
  const fromEnv = {
    url: process.env.NOPM_API_URL,
    token: process.env.NOPM_TOKEN,
  };
  let fromFile = {};
  if (existsSync(CFG_FILE)) {
    try { fromFile = JSON.parse(readFileSync(CFG_FILE, "utf8")); } catch {}
  }
  return {
    url: fromEnv.url || fromFile.url || "http://localhost:3000",
    token: fromEnv.token || fromFile.token || null,
  };
}

export function saveConfig(cfg) {
  if (!existsSync(CFG_DIR)) mkdirSync(CFG_DIR, { recursive: true });
  writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
}

/**
 * Make an authenticated request to the NoPM API.
 * Returns the parsed JSON envelope ({ data, ... }).
 * Throws an Error with .status on non-2xx.
 */
export async function api(method, p, body) {
  const cfg = loadConfig();
  if (!cfg.token) die("No token. Run: nopm auth set-token <token> [--url <url>]");
  const res = await fetch(cfg.url + p, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${json.error || JSON.stringify(json)}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

/**
 * Print data as an aligned table, or as JSON when ctx.flags.json is set.
 * columns is optional — defaults to the keys of the first row.
 */
export function out(data, ctx, columns) {
  const flags = ctx && ctx.flags ? ctx.flags : (ctx || {});
  if (flags.json) return console.log(JSON.stringify(data, null, 2));
  const rows = Array.isArray(data) ? data : [data];
  if (!rows.length) return console.log("(none)");
  const cols = columns || Object.keys(rows[0]);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (vals) => vals.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ");
  console.log(line(cols));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
}

/**
 * Parse argv into { _: [positionals], <named flag>: value }.
 * --flag x  => { flag: "x" }
 * --flag    => { flag: true }
 */
export function parseFlags(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      result[k] = next && !next.startsWith("--") ? argv[++i] : true;
    } else {
      result._.push(a);
    }
  }
  return result;
}

/** Print to stderr and exit 1. */
export function die(msg, payload) {
  console.error("✗ " + msg);
  if (payload?.fields) for (const f of payload.fields) console.error(`  - ${f.field}: ${f.message}`);
  process.exit(1);
}

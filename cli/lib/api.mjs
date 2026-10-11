// cli/lib/api.mjs — shared helpers for all nopm commands
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CFG_DIR = path.join(homedir(), ".nopm");
const CFG_FILE = path.join(CFG_DIR, "config.json");

/**
 * Terminal-failure signal. die() throws this instead of calling
 * process.exit(): exiting mid-request leaves undici sockets half-closed and
 * (on Windows) trips a libuv assertion on the way out. The dispatcher in
 * nopm.mjs catches it, prints, and sets process.exitCode so node exits
 * cleanly once the event loop drains.
 */
export class CliError extends Error {
  constructor(message, payload) {
    super(message);
    this.payload = payload;
    this.isCliError = true;
  }
}

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
  // The config file holds a PAT — owner-only permissions (no-op on Windows ACLs).
  if (!existsSync(CFG_DIR)) mkdirSync(CFG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** Render the curl equivalent of a request (token masked as $NOPM_TOKEN). */
function toCurl(method, url, body) {
  const parts = [`curl -X ${method} '${url}'`, `-H 'Authorization: Bearer '"$NOPM_TOKEN"''`];
  if (body) parts.push(`-H 'Content-Type: application/json'`, `-d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`);
  return parts.join(" \\\n  ");
}

/**
 * Make an authenticated request to the NoPM API.
 * Returns the parsed JSON envelope ({ data, ... }).
 * Throws a CliError with .status on non-2xx.
 * opts.curl: print the equivalent curl command instead of executing (dry run).
 */
export async function api(method, p, body, opts = {}) {
  const cfg = loadConfig();
  if (!cfg.token) die("No token. Run: nopm auth set-token <token> [--url <url>]");
  if (opts.curl) {
    console.log(toCurl(method, cfg.url + p, body));
    throw new CliDryRun();
  }
  const res = await fetch(cfg.url + p, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
      "X-NoPM-Client": "cli",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 412) {
      // R-90 optimistic concurrency: --expected-updated-at was sent and no
      // longer matches the row. Friendly message via the normal CliError
      // path — main()'s catch prints it (or, under --json, the raw body).
      const cur = json.current_updated_at || "unknown";
      const err = new CliError(
        `Precondition failed: the record changed since you loaded it (current updated_at: ${cur}). Re-run with --expected-updated-at ${cur} after reviewing.`,
        json,
      );
      err.status = 412;
      throw err;
    }
    const err = new CliError(`HTTP ${res.status}: ${json.error || JSON.stringify(json)}`, json);
    err.status = res.status;
    throw err;
  }
  return json;
}

/** Thrown after a --curl dry-run has printed; the dispatcher exits 0. */
export class CliDryRun extends Error {
  constructor() {
    super("dry run");
    this.isDryRun = true;
  }
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
 * --flag x        => { flag: "x" }
 * --flag          => { flag: true }
 * --flag=x        => { flag: "x" }   (use for values that start with "--")
 * -h              => { help: true }
 */
export function parseFlags(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") {
      result.help = true;
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        result[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const k = a.slice(2);
        const next = argv[i + 1];
        result[k] = next !== undefined && !next.startsWith("--") ? argv[++i] : true;
      }
    } else {
      result._.push(a);
    }
  }
  return result;
}

/** Report a terminal failure. Throws CliError — never returns. */
export function die(msg, payload) {
  throw new CliError(msg, payload);
}

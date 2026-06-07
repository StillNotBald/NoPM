#!/usr/bin/env node
// nopm — a thin CLI for the NoPM API. Drives the product the way `gh`/`supabase`/`aws` do:
// scoped Bearer token, documented endpoints, machine-readable JSON (--json).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CFG_DIR = path.join(homedir(), ".nopm");
const CFG_FILE = path.join(CFG_DIR, "config.json");

function loadConfig() {
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

function saveConfig(cfg) {
  if (!existsSync(CFG_DIR)) mkdirSync(CFG_DIR, { recursive: true });
  writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
}

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = args[i + 1];
      out[k] = next && !next.startsWith("--") ? args[++i] : true;
    } else out._.push(a);
  }
  return out;
}

async function api(method, p, body) {
  const cfg = loadConfig();
  if (!cfg.token) die("No token. Run: nopm auth set-token <token> [--url <url>]");
  const res = await fetch(cfg.url + p, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) die(`HTTP ${res.status}: ${json.error || JSON.stringify(json)}`, json);
  return json;
}

function die(msg, payload) {
  console.error("✗ " + msg);
  if (payload?.fields) for (const f of payload.fields) console.error(`  - ${f.field}: ${f.message}`);
  process.exit(1);
}

function out(data, flags, columns) {
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

const [cmd, sub, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

const commands = {
  async auth() {
    if (sub === "set-token") {
      const token = flags._[0];
      if (!token) die("usage: nopm auth set-token <token> [--url <url>]");
      const cfg = loadConfig();
      saveConfig({ url: flags.url || cfg.url, token });
      console.log(`✓ token saved to ${CFG_FILE} (url: ${flags.url || cfg.url})`);
    } else die("usage: nopm auth set-token <token> [--url <url>]");
  },
  async whoami() {
    const { data } = await api("GET", "/api/me");
    out(data, flags);
  },
  async projects() {
    if (sub === "ls" || !sub) {
      const { data } = await api("GET", "/api/projects?limit=100");
      out(data, flags, ["id", "code", "name", "rag_status", "completion_pct"]);
    } else if (sub === "create") {
      if (!flags.name) die("usage: nopm projects create --name <name> [--code <code>] [--program <p>]");
      const { data } = await api("POST", "/api/projects", {
        name: flags.name, code: flags.code, program: flags.program,
      });
      console.log("✓ created project", data.id);
      out(data, flags, ["id", "code", "name", "rag_status"]);
    } else die("usage: nopm projects [ls|create]");
  },
  async tasks() {
    if (sub === "ls") {
      if (!flags.project) die("usage: nopm tasks ls --project <projectId>");
      const { data } = await api("GET", `/api/projects/${flags.project}/tasks?limit=100`);
      out(data, flags, ["id", "name", "status", "status_type", "priority"]);
    } else if (sub === "create") {
      if (!flags.project || !flags.name) die("usage: nopm tasks create --project <id> --name <name>");
      const { data } = await api("POST", `/api/projects/${flags.project}/tasks`, { name: flags.name });
      console.log("✓ created task", data.id);
      out(data, flags, ["id", "name", "status_type"]);
    } else if (sub === "rm") {
      const id = flags._[0];
      if (!id) die("usage: nopm tasks rm <taskId> --reason <why>");
      const data = await api("DELETE", `/api/tasks/${id}`, { reason: flags.reason || "removed via CLI" });
      console.log("⏸ delete requested — pending a checker's approval (four-eyes).");
      out(data.data || data, flags);
    } else die("usage: nopm tasks [ls|create|rm]");
  },
  async approvals() {
    const { data } = await api("GET", "/api/deletion-requests?status=pending");
    out(data, flags, ["id", "target_type", "target_id", "requested_by_label", "status"]);
  },
  async approve() {
    const id = sub;
    if (!id) die("usage: nopm approve <deletionRequestId>   (needs a checker token)");
    const { data } = await api("POST", `/api/deletion-requests/${id}/approve`);
    console.log("✓ approved & committed.");
    out(data, flags);
  },
  async audit() {
    const limit = flags.limit || 20;
    const { data } = await api("GET", `/api/audit?limit=${limit}`);
    out(data, flags, ["created_at", "actor_label", "action", "target_type", "target_id"]);
  },
  help() {
    console.log(`nopm — drive NoPM from your terminal / agent

  nopm auth set-token <token> [--url <url>]   save a scoped PAT
  nopm whoami                                 show the current actor + scopes
  nopm projects ls                            list projects
  nopm projects create --name <n> [--code]    create a project
  nopm tasks ls --project <id>                list a project's tasks
  nopm tasks create --project <id> --name <n> create a task
  nopm tasks rm <taskId> --reason <why>       request deletion (maker — four-eyes)
  nopm approvals                              list pending deletion requests
  nopm approve <requestId>                    approve+commit (checker, different token)
  nopm audit [--limit N]                      tail the immutable audit log

  global: --json for machine output`);
  },
};

(commands[cmd] || commands.help)().catch((e) => die(e.message));

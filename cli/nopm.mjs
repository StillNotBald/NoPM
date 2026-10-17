#!/usr/bin/env node
// nopm — thin CLI for the NoPM API.
// Dispatcher: parse argv → group + rest → dynamic-import commands/<group>.mjs → run()
// help: aggregates each module's describe + usage (no central registry to maintain)

import { api, out, die, parseFlags, loadConfig } from "./lib/api.mjs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));

async function showHelp() {
  const cmdsDir = path.join(__dir, "commands");
  let files;
  try {
    files = (await readdir(cmdsDir)).filter((f) => f.endsWith(".mjs")).sort();
  } catch {
    files = [];
  }

  console.log("nopm — drive NoPM from your terminal / agent\n");
  for (const f of files) {
    const mod = await import(`./commands/${f}`).catch(() => null);
    if (!mod) continue;
    const group = f.replace(".mjs", "");
    console.log(`  ${group}  —  ${mod.describe ?? ""}`);
    if (mod.usage) {
      for (const u of mod.usage) console.log(`    ${u}`);
    }
    console.log();
  }
  console.log("  global: --json for machine output, --curl to print the request instead of sending it");
}

async function showVersion() {
  const pkg = JSON.parse(await readFile(path.join(__dir, "package.json"), "utf8"));
  console.log(`nopm ${pkg.version}`);
}

// Set inside main() once flags are parsed; read by the top-level .catch()
// below so a 412's --json rendering can print the raw error body instead of
// the friendly text (main() itself doesn't handle the error — the request
// only fails once mod.run() starts making API calls).
let currentFlags = {};

async function main() {
  const argv = process.argv.slice(2);
  const [group, ...rest] = argv;

  if (!group || group === "help" || group === "--help" || group === "-h") {
    await showHelp();
    return;
  }
  if (group === "--version" || group === "-v") {
    await showVersion();
    return;
  }

  // Build context that every command module receives
  const flags = parseFlags(rest);
  currentFlags = flags;
  const ctx = {
    flags,
    api: (method, p, body) => api(method, p, body, { curl: flags.curl, idempotencyKey: flags["idempotency-key"] }),
    out: (data, _ctx, columns) => out(data, { flags }, columns),
    die,
    loadConfig,
  };

  let mod;
  try {
    mod = await import(`./commands/${group}.mjs`);
  } catch (e) {
    if (e.code === "ERR_MODULE_NOT_FOUND") {
      console.error(`✗ Unknown command: ${group}`);
      console.error("Run  nopm help  for available commands.");
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  // `nopm <group> --help` / `-h` prints the group's usage — it must NEVER
  // fall through to a default subcommand and fire a live API call.
  if (flags.help) {
    console.log(`${group}  —  ${mod.describe ?? ""}`);
    for (const u of mod.usage ?? []) console.log(`  ${u}`);
    return;
  }

  await mod.run(rest, ctx);
}

main().catch((e) => {
  if (e?.isDryRun) return; // --curl printed the request; nothing was sent
  // R-90: --json must still surface the raw 412 error body (current_updated_at
  // and all), not the human-readable sentence, so a scripted caller can parse it.
  if (e?.status === 412 && currentFlags.json) {
    console.log(JSON.stringify(e.payload ?? {}, null, 2));
    process.exitCode = 1;
    return;
  }
  // CliError (and structured API errors) carry a user-friendly message
  console.error("✗ " + e.message);
  if (e?.payload?.fields) {
    for (const f of e.payload.fields) console.error(`  - ${f.field}: ${f.message}`);
  }
  process.exitCode = 1;
});

#!/usr/bin/env node
// nopm — thin CLI for the NoPM API.
// Dispatcher: parse argv → group + rest → dynamic-import commands/<group>.mjs → run()
// help: aggregates each module's describe + usage (no central registry to maintain)

import { api, out, die, parseFlags, loadConfig } from "./lib/api.mjs";
import { readdir } from "node:fs/promises";
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
  console.log("  global: --json for machine output");
}

async function main() {
  const argv = process.argv.slice(2);
  const [group, ...rest] = argv;

  if (!group || group === "help" || group === "--help" || group === "-h") {
    await showHelp();
    return;
  }

  // Build context that every command module receives
  const flags = parseFlags(rest);
  const ctx = {
    flags,
    api: (method, p, body) => api(method, p, body),
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
      process.exit(1);
    }
    throw e;
  }

  await mod.run(rest, ctx);
}

main().catch((e) => {
  // Structured API errors already have a user-friendly message from api()
  die(e.message, e.payload);
});
